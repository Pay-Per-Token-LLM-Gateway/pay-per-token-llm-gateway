// ──────────────────────────────────────────────
// @x402/x402-core — x402 Protocol Implementation
// ──────────────────────────────────────────────

import {
  Quote,
  PaymentVerification,
  PaymentReceipt,
  PaymentRequiredResponse,
  RouteConfig,
  PaymentAsset,
  StellarNetwork,
  StellarAddress,
  TxHash,
} from '@x402/types';
import { generateId, nowUnix, unitsToStroops } from '@x402/shared';
import { logger } from '@x402/logger';

// ── Quote Generation ─────────────────────────

export interface QuoteGeneratorOptions {
  route: RouteConfig;
  providerAddress: StellarAddress;
  gatewayBaseUrl: string;
  network: StellarNetwork;
  quoteExpirySeconds: number;
  usdcIssuer: string;
  /** Estimated max tokens for per-token pricing (from request max_tokens) */
  estimatedTokens?: number;
  /** Minimum payment amount in stroops (defaults to 10000) */
  minPaymentAmount?: string;
}

/** Default token estimate when max_tokens is not specified */
const DEFAULT_TOKEN_ESTIMATE = 4096;
const DEFAULT_MIN_PAYMENT_AMOUNT = '10000';

/**
 * Generate a payment quote for a given route configuration.
 *
 * For flat pricing: amount = flatPrice (exact charge per request).
 * For per-token pricing: amount = perTokenPrice × estimatedTokens (deposit).
 *   The actual cost is calculated after the LLM response based on usage.total_tokens.
 */
export function generateQuote(options: QuoteGeneratorOptions): Quote {
  const expiresAt = nowUnix() + options.quoteExpirySeconds;
  const quoteId = generateId();
  const asset: PaymentAsset = options.route.acceptedAssets[0] || 'USDC';

  let amount: string;
  let estimatedMaxTokens: number | undefined;
  let perTokenPrice: string | undefined;

  // Safe BigInt parser helper
  const parseBigIntSafe = (val: string | undefined, fallback: bigint): bigint => {
    if (!val) return fallback;
    try {
      return BigInt(val);
    } catch {
      return fallback;
    }
  };

  if (options.route.pricingModel === 'per_token' && options.route.perTokenPrice) {
    // Per-token: charge estimated deposit
    perTokenPrice = options.route.perTokenPrice;
    estimatedMaxTokens = options.estimatedTokens || DEFAULT_TOKEN_ESTIMATE;
    const priceBI = parseBigIntSafe(options.route.perTokenPrice, 0n);
    amount = (priceBI * BigInt(estimatedMaxTokens)).toString();
  } else {
    // Flat: charge flat price
    amount = options.route.flatPrice || '0';
  }

  // Enforce minimum payment amount
  const defaultMinBI = parseBigIntSafe(DEFAULT_MIN_PAYMENT_AMOUNT, 10000n);
  const minAmount = parseBigIntSafe(options.minPaymentAmount, defaultMinBI);
  const currentAmountBI = parseBigIntSafe(amount, 0n);
  if (currentAmountBI < minAmount) {
    amount = minAmount.toString();
  }

  // MEMO_TEXT is limited to 28 bytes. Derive a deterministic short memo from
  // the quote id (UUID hex, dashes stripped → 32 chars, truncated to 24) so
  // payments can be attributed to their quote on-chain.
  const memo = quoteId.replace(/-/g, '').slice(0, 24);

  return {
    id: quoteId,
    route: options.route.path,
    pricingModel: options.route.pricingModel,
    amount,
    asset,
    assetIssuer: asset === 'USDC' ? options.usdcIssuer : undefined,
    paymentAddress: options.providerAddress,
    memo,
    network: options.network,
    expiresAt,
    statusUrl: `${options.gatewayBaseUrl}/api/v1/payments/${quoteId}/status`,
    estimatedMaxTokens,
    perTokenPrice,
  };
}

// ── 402 Response Builder ─────────────────────

export interface PaymentRequiredBuilderOptions {
  quote: Quote;
  gatewayBaseUrl: string;
}

/**
 * Build a standard HTTP 402 Payment Required response.
 */
export function buildPaymentRequiredResponse(
  options: PaymentRequiredBuilderOptions,
): PaymentRequiredResponse {
  const { quote, gatewayBaseUrl } = options;

  const pricingNote =
    quote.pricingModel === 'per_token'
      ? `\n(Pricing: ${quote.perTokenPrice} stroops per token, estimated for ${quote.estimatedMaxTokens} tokens)`
      : '';

  const instructions = [
    `Payment of ${quote.amount} ${quote.asset} is required to access ${quote.route}.${pricingNote}`,
    '',
    'To pay:',
    `1. Send ${quote.amount} ${quote.asset} to ${quote.paymentAddress}`,
    ...(quote.memo ? [`   Memo: ${quote.memo}`] : []),
    `2. Note the transaction hash`,
    `3. Retry your request with the header: X-Payment-Hash: <tx_hash>`,
    `4. Or check payment status at: ${quote.statusUrl}`,
    '',
    `This quote expires at: ${new Date(quote.expiresAt * 1000).toISOString()}`,
  ].join('\n');

  return {
    status: 402,
    message: 'Payment Required',
    quote,
    instructions,
    docs: `${gatewayBaseUrl}/docs/x402`,
  };
}

// ── Payment Verification ─────────────────────

export interface VerifyPaymentOptions {
  txHash: TxHash;
  quote: Quote;
  horizonUrl: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  /** Minimum payment amount in stroops (defaults to 10000) */
  minPaymentAmount?: string;
}

/**
 * Verify a Stellar payment on-chain.
 *
 * For flat pricing: exact amount match required.
 * For per-token pricing: the payment must cover the quoted deposit
 *   (perTokenPrice × estimated tokens); an exact match is not required because
 *   the actual cost is reconciled after the response.
 */
export async function verifyStellarPayment(
  options: VerifyPaymentOptions,
): Promise<PaymentVerification> {
  const { txHash, quote, horizonUrl } = options;

  logger.info('Verifying payment', { txHash, quoteId: quote.id });

  try {
    // Fetch transaction from Horizon
    const response = await fetch(`${horizonUrl}/transactions/${txHash}`);
    if (!response.ok) {
      if (response.status === 404) {
        return {
          verified: false,
          txHash,
          payerAddress: '',
          amount: '0',
          asset: quote.asset,
          ledger: 0,
          timestamp: 0,
          failureReason: 'Transaction not found on chain',
        };
      }
      throw new Error(`Horizon error: ${response.status} ${response.statusText}`);
    }

    const txData = (await response.json()) as Record<string, any>;

    // NOTE: quote memos are issued for on-chain attribution (the client pays
    // with the memo, so payments are traceable to their quote), but they are
    // NOT enforced here. The gateway's retry flow (402 → pay → X-Payment-Hash)
    // verifies against a freshly generated quote, so a hard memo requirement
    // would never match and would reject every valid payment. Replay
    // protection (Redis + on-chain + DB single-use) is the access control.

    // Check transaction succeeded
    if (!txData.successful) {
      return {
        verified: false,
        txHash,
        payerAddress: txData.source_account || '',
        amount: '0',
        asset: quote.asset,
        ledger: txData.ledger || 0,
        timestamp: Date.parse(txData.created_at) / 1000 || 0,
        failureReason: 'Transaction failed on chain',
      };
    }

    // Fetch payment operations
    const opsResponse = await fetch(`${horizonUrl}/transactions/${txHash}/operations`);
    if (!opsResponse.ok) {
      throw new Error(`Horizon operations error: ${opsResponse.status}`);
    }

    const opsData = (await opsResponse.json()) as Record<string, any>;
    const paymentOps =
      (opsData._embedded?.records as any[])?.filter(
        (op: any) =>
          op.type === 'payment' ||
          op.type === 'path_payment_strict_send' ||
          op.type === 'path_payment_strict_receive',
      ) || [];

    // Amount required to satisfy this quote, in stroops — computed once up
    // front. A malformed quote price means nothing can match.
    let requiredAmount: bigint;
    try {
      if (quote.pricingModel === 'per_token') {
        // Deposit enforcement: the payment must cover the quoted deposit
        // (perTokenPrice × estimated tokens). The actual cost is reconciled
        // after the LLM response via over/under-payment headers, so accepting
        // anything less than the deposit would let callers underpay for the
        // service. Falls back to the per-token price, then 1 stroop, for
        // degenerate configs where the deposit computes to zero.
        const deposit = BigInt(quote.amount);
        requiredAmount =
          deposit > 0n
            ? deposit
            : quote.perTokenPrice && BigInt(quote.perTokenPrice) > 0n
              ? BigInt(quote.perTokenPrice)
              : 1n;
      } else {
        // Flat: exact amount match (both sides in stroops)
        requiredAmount = BigInt(quote.amount);
      }
      let minAmount = 10000n;
      try {
        minAmount = BigInt(options.minPaymentAmount || DEFAULT_MIN_PAYMENT_AMOUNT);
      } catch {
        // Fall back to default minimum if misconfigured
        minAmount = 10000n;
      }
      if (requiredAmount < minAmount) {
        requiredAmount = minAmount;
      }
    } catch {
      // Malformed quote price → nothing can match
      return {
        verified: false,
        txHash,
        payerAddress: txData.source_account || '',
        amount: '0',
        asset: quote.asset,
        ledger: txData.ledger || 0,
        timestamp: Date.parse(txData.created_at) / 1000 || 0,
        failureReason: 'No matching payment operation found',
      };
    }

    // Find a matching payment. Track operations that reached the provider in
    // the right asset so we can report a clear reason when the amount is the
    // only thing that didn't match.
    let sawProviderOp = false;
    let largestProviderAmount = 0n;

    const matchingPayment = paymentOps.find((op: any) => {
      const assetMatches =
        quote.asset === 'XLM'
          ? op.asset_type === 'native'
          : op.asset_code === quote.asset && op.asset_issuer === quote.assetIssuer;

      if (!assetMatches || op.to !== quote.paymentAddress) return false;

      sawProviderOp = true;

      // Horizon reports amounts as decimal strings in asset units
      // (e.g. "0.1000000" for 0.1 USDC), while x402 quotes use stroops
      // (e.g. "1000000"). Normalize to stroops before comparing.
      let amountStroops: bigint;
      try {
        amountStroops = BigInt(unitsToStroops(op.amount));
      } catch {
        // Non-numeric amount → this op can never satisfy the quote
        return false;
      }

      if (amountStroops > largestProviderAmount) {
        largestProviderAmount = amountStroops;
      }

      // Per-token: must cover the quoted deposit (>=). Flat: exact match.
      return quote.pricingModel === 'per_token'
        ? amountStroops >= requiredAmount
        : amountStroops === requiredAmount;
    });

    if (!matchingPayment) {
      // A payment reached the provider in the right asset but didn't cover
      // the quoted per-token deposit → tell the caller what's missing
      // instead of a generic "no match".
      const belowDeposit =
        quote.pricingModel === 'per_token' && sawProviderOp && largestProviderAmount > 0n;

      return {
        verified: false,
        txHash,
        payerAddress: txData.source_account || '',
        amount: belowDeposit ? largestProviderAmount.toString() : '0',
        asset: quote.asset,
        ledger: txData.ledger || 0,
        timestamp: Date.parse(txData.created_at) / 1000 || 0,
        failureReason: belowDeposit
          ? `Payment amount is below the quoted deposit of ${quote.amount} ${quote.asset}`
          : 'No matching payment operation found',
      };
    }

    // Verify quote hasn't expired
    const txTime = Date.parse(txData.created_at) / 1000;
    const amountStroops = unitsToStroops(matchingPayment.amount);
    if (txTime > quote.expiresAt) {
      return {
        verified: false,
        txHash,
        payerAddress: matchingPayment.from || txData.source_account,
        amount: amountStroops,
        asset: quote.asset,
        ledger: txData.ledger || 0,
        timestamp: txTime,
        failureReason: 'Payment was made after quote expired',
      };
    }

    // Payment verified!
    logger.info('Payment verified successfully', {
      txHash,
      quoteId: quote.id,
    });

    return {
      verified: true,
      txHash,
      payerAddress: matchingPayment.from || txData.source_account,
      amount: amountStroops,
      asset: quote.asset,
      ledger: txData.ledger || 0,
      timestamp: txTime,
    };
  } catch (error) {
    logger.error('Payment verification error', {
      txHash,
      error: String(error),
    });
    return {
      verified: false,
      txHash,
      payerAddress: '',
      amount: '0',
      asset: quote.asset,
      ledger: 0,
      timestamp: 0,
      failureReason: `Verification error: ${(error as Error).message}`,
    };
  }
}

// ── Receipt Generation ───────────────────────

export function generateReceipt(verification: PaymentVerification, quote: Quote): PaymentReceipt {
  return {
    id: generateId(),
    quoteId: quote.id,
    txHash: verification.txHash,
    payerAddress: verification.payerAddress,
    amount: verification.amount,
    asset: verification.asset,
    route: quote.route,
    status: 'confirmed',
    verifiedAt: new Date(verification.timestamp * 1000).toISOString(),
    ledger: verification.ledger,
  };
}

// ── Replay Protection ────────────────────────

/**
 * Minimal interface for Redis operations needed by ReplayProtection.
 * ioredis satisfies this interface natively.
 */
export interface RedisLike {
  exists(key: string): Promise<number>;
  set(key: string, value: string, ...args: string[]): Promise<string | null>;
}

/**
 * Replay protection backed by Redis (when available) with in-memory fallback.
 *
 * When a Redis client is provided via constructor, all operations are
 * persisted to Redis with proper TTLs. This survives server restarts
 * and works correctly in multi-instance deployments.
 *
 * When no Redis client is provided, falls back to an in-memory Set
 * (useful for development and testing).
 */
export class ReplayProtection {
  private readonly redis: RedisLike | null;
  private readonly usedPayments = new Set<string>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  private static readonly KEY_PREFIX = 'x402:replay:';

  constructor(redis?: RedisLike) {
    this.redis = redis ?? null;
  }

  /** Check whether a transaction hash has already been used. */
  async isUsed(txHash: TxHash): Promise<boolean> {
    if (this.redis) {
      const exists = await this.redis.exists(ReplayProtection.KEY_PREFIX + txHash);
      return exists === 1;
    }
    return this.usedPayments.has(txHash);
  }

  /**
   * Atomically claim a transaction hash as used (Redis SET NX).
   * Returns true only if this caller won the claim — concurrent requests with
   * the same hash race here and exactly one wins. When no Redis client is
   * available, falls back to the in-memory set.
   */
  async claim(txHash: TxHash, ttlSeconds = 3600): Promise<boolean> {
    if (this.redis) {
      const result = await this.redis.set(
        ReplayProtection.KEY_PREFIX + txHash,
        '1',
        'EX',
        String(ttlSeconds),
        'NX',
      );
      return result === 'OK';
    }

    if (this.usedPayments.has(txHash)) return false;
    await this.markUsed(txHash, ttlSeconds);
    return true;
  }

  /** Mark a transaction hash as used with a TTL. */
  async markUsed(txHash: TxHash, ttlSeconds = 3600): Promise<void> {
    if (this.redis) {
      await this.redis.set(ReplayProtection.KEY_PREFIX + txHash, '1', 'EX', String(ttlSeconds));
      return;
    }

    this.usedPayments.add(txHash);

    const existing = this.expiryTimers.get(txHash);
    if (existing) clearTimeout(existing);

    this.expiryTimers.set(
      txHash,
      setTimeout(() => {
        this.usedPayments.delete(txHash);
        this.expiryTimers.delete(txHash);
      }, ttlSeconds * 1000),
    );
  }

  /**
   * Number of tracked entries. Only accurate in in-memory mode;
   * throws when Redis is active (use Redis directly for metrics).
   */
  get size(): number {
    if (this.redis) {
      throw new Error('size is not available when Redis is in use');
    }
    return this.usedPayments.size;
  }
}

// ── Price Calculation ────────────────────────

export interface PriceCalculationOptions {
  route: RouteConfig;
  /** For per-token pricing: the number of tokens used */
  tokenCount?: number;
}

/**
 * Calculate the price for a request based on route pricing config.
 * For flat pricing: returns the flat price.
 * For per-token pricing: returns perTokenPrice × tokenCount.
 */
export function calculatePrice(options: PriceCalculationOptions): {
  amount: string;
  asset: PaymentAsset;
  /** For per-token: how much was overpaid or underpaid (negative = underpaid) */
  surplus?: string;
} {
  const { route, tokenCount } = options;
  const asset = route.acceptedAssets[0] || 'USDC';

  if (route.pricingModel === 'flat' && route.flatPrice) {
    return { amount: route.flatPrice, asset };
  }

  if (route.pricingModel === 'per_token' && route.perTokenPrice && tokenCount) {
    const total = (BigInt(route.perTokenPrice) * BigInt(tokenCount)).toString();
    return { amount: total, asset };
  }

  logger.warn('Could not calculate price', {
    route: route.path,
    pricingModel: route.pricingModel,
  });
  return { amount: '0', asset };
}

/**
 * Compare the paid amount against the actual cost.
 * Returns a surplus (positive = overpaid, zero = exact, negative = underpaid).
 */
export function comparePayment(
  paidAmount: string,
  actualCost: string,
): { surplus: string; isOverpaid: boolean; isUnderpaid: boolean } {
  const paid = BigInt(paidAmount);
  const cost = BigInt(actualCost);
  const surplusBig = paid - cost;

  // Underpaid: paid less than actual cost. Cap at 0 to avoid negative cost in response.
  if (surplusBig < 0n) {
    return {
      surplus: surplusBig.toString(),
      isOverpaid: false,
      isUnderpaid: true,
    };
  }

  return {
    surplus: surplusBig.toString(),
    isOverpaid: surplusBig > 0n,
    isUnderpaid: false,
  };
}
