// ──────────────────────────────────────────────
// @x402/sdk — Client SDK for the 402 → pay → retry flow
// ──────────────────────────────────────────────

import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
  PaymentRequiredResponse,
  Quote,
  PaymentReceipt,
  X402ClientConfig,
  X402CallResult,
  X402StreamResult,
  PaymentAsset,
  StellarNetwork,
} from '@x402/types';
import { sleep, stroopsToUnits } from '@x402/shared';
import { logger } from '@x402/logger';
import {
  buildPaymentTransaction,
  buildUnsignedPaymentTransaction,
  createHorizonServer,
} from '@x402/wallet';

// ── Default Configuration ────────────────────

const DEFAULT_CONFIG: Partial<X402ClientConfig> = {
  network: 'testnet',
  defaultAsset: 'USDC',
  paymentTimeout: 300_000, // 5 minutes
};

/**
 * x402 Client — automatically handles 402 → pay → retry.
 */
export class X402Client {
  private config: X402ClientConfig;

  constructor(config: X402ClientConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Public API ──────────────────────────────

  /**
   * Make an LLM API call through the x402 gateway.
   * Automatically handles 402 responses by paying and retrying.
   */
  async call(
    request: ChatCompletionRequest,
    options?: {
      path?: string;
      asset?: PaymentAsset;
      headers?: Record<string, string>;
    },
  ): Promise<X402CallResult> {
    const route = options?.path || '/v1/chat/completions';
    const url = `${this.config.gatewayUrl}${route}`;

    logger.info('Making x402 call', { url, model: request.model });

    const firstResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: JSON.stringify(request),
    });

    // 402 → handle payment + retry
    if (firstResponse.status === 402) {
      const paymentRequired: PaymentRequiredResponse = await firstResponse.json();
      await firstResponse.body?.cancel();
      return this.handle402Payment(paymentRequired, request, route, options, false);
    }

    if (firstResponse.ok) {
      const response: ChatCompletionResponse = await firstResponse.json();
      return { success: true, response, cost: { amount: '0', asset: 'USDC' } };
    }

    const errorBody = await firstResponse.text();
    return { success: false, error: `Gateway error: ${firstResponse.status} ${errorBody}` };
  }

  /**
   * Make a streaming LLM API call through the x402 gateway.
   * Returns an async generator of SSE chunks.
   */
  async callStream(
    request: ChatCompletionRequest,
    options?: { path?: string; asset?: PaymentAsset; headers?: Record<string, string> },
  ): Promise<X402StreamResult> {
    const route = options?.path || '/v1/chat/completions';
    const streamingRequest = { ...request, stream: true };
    const url = `${this.config.gatewayUrl}${route}`;

    const firstResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: JSON.stringify(streamingRequest),
    });

    if (firstResponse.status === 402) {
      const paymentRequired: PaymentRequiredResponse = await firstResponse.json();
      await firstResponse.body?.cancel();
      return this.handle402Payment(paymentRequired, streamingRequest, route, options, true);
    }

    if (firstResponse.ok) {
      const headerReceipt = this.parseReceiptHeader(firstResponse.headers.get('X-Payment-Receipt'));
      const receiptRef: { receipt: PaymentReceipt | undefined } = { receipt: headerReceipt };
      // The gateway sends a preliminary X-Payment-Receipt header before the
      // stream starts and a final x402_receipt trailing SSE event after it
      // completes. Expose receipt/cost lazily so the result reflects the
      // final receipt (actual cost for per-token routes) once the stream has
      // been consumed, while still being available immediately from the
      // header for flat-rate routes.
      return {
        success: true,
        stream: this.sseGenerator(firstResponse, receiptRef),
        get receipt(): PaymentReceipt | undefined {
          return receiptRef.receipt ?? headerReceipt;
        },
        get cost(): { amount: string; asset: PaymentAsset } | undefined {
          const r = receiptRef.receipt ?? headerReceipt;
          return r ? { amount: r.amount, asset: r.asset as PaymentAsset } : undefined;
        },
      };
    }

    const errorBody = await firstResponse.text();
    return { success: false, error: `Gateway error: ${firstResponse.status} ${errorBody}` };
  }

  /** Check the payment status for a quote. */
  async checkPaymentStatus(quoteId: string): Promise<PaymentReceipt | null> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/v1/payments/${quoteId}/status`);
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  // ── Shared Payment Logic ────────────────────

  /**
   * Shared 402 → pay → retry flow used by both call() and callStream().
   */
  private async handle402Payment(
    paymentRequired: PaymentRequiredResponse,
    request: ChatCompletionRequest,
    route: string,
    options: { headers?: Record<string, string>; asset?: PaymentAsset } | undefined,
    isStream: boolean,
  ): Promise<X402CallResult | X402StreamResult> {
    const { quote } = paymentRequired;

    // Validate quote
    if (Date.now() / 1000 > quote.expiresAt) {
      return { success: false, error: 'Quote expired before payment could be made' };
    }

    const requiredAsset = options?.asset || this.config.defaultAsset || 'USDC';
    if (requiredAsset !== quote.asset) {
      return {
        success: false,
        error: `Wrong asset: gateway requires ${quote.asset}, you're paying with ${requiredAsset}`,
      };
    }

    // Execute payment
    const txHashResult = await this.executePayment(quote);
    if (!txHashResult.success) {
      return txHashResult;
    }

    // Retry the request with payment proof
    const url = `${this.config.gatewayUrl}${route}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment-Hash': txHashResult.txHash!,
        ...options?.headers,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        success: false,
        error: `Gateway error after payment: ${response.status} ${errorBody}`,
      };
    }

    if (isStream) {
      const headerReceipt = this.parseReceiptHeader(response.headers.get('X-Payment-Receipt'));
      const receiptRef: { receipt: PaymentReceipt | undefined } = { receipt: headerReceipt };
      // The gateway sends a preliminary X-Payment-Receipt header before the
      // stream starts and a final x402_receipt trailing SSE event after it
      // completes. Expose receipt/cost lazily so the result reflects the
      // final receipt (actual cost for per-token routes) once the stream has
      // been consumed, while still being available immediately from the
      // header for flat-rate routes.
      return {
        success: true,
        stream: this.sseGenerator(response, receiptRef),
        get receipt(): PaymentReceipt | undefined {
          return receiptRef.receipt ?? headerReceipt;
        },
        get cost(): { amount: string; asset: PaymentAsset } | undefined {
          const r = receiptRef.receipt ?? headerReceipt;
          return r ? { amount: r.amount, asset: r.asset as PaymentAsset } : undefined;
        },
      } as X402StreamResult;
    }

    const llmResponse: ChatCompletionResponse = await response.json();
    const receipt: PaymentReceipt | undefined = response.headers.get('X-Payment-Receipt')
      ? JSON.parse(response.headers.get('X-Payment-Receipt')!)
      : undefined;

    return {
      success: true,
      response: llmResponse,
      receipt,
      cost: receipt ? { amount: receipt.amount, asset: receipt.asset as PaymentAsset } : undefined,
    } as X402CallResult;
  }

  /**
   * Build, submit, and confirm a Stellar payment for the given quote.
   * Returns the txHash on success, or an error result on failure.
   *
   * Supports two signing modes:
   *   secretKey — the SDK holds the key and signs directly.
   *   publicKey + signTransaction — external wallet signing (browser
   *     extension, hardware wallet, agent SDK) where the SDK builds an
   *     unsigned XDR, hands it to the signer, then submits the signed XDR.
   */
  private async executePayment(
    quote: Quote,
  ): Promise<{ success: true; txHash: string } | { success: false; error: string }> {
    // External signer path: build unsigned XDR, get it signed, submit.
    if (this.config.signTransaction) {
      if (!this.config.publicKey) {
        return {
          success: false,
          error: 'publicKey is required when using signTransaction (external wallet signing)',
        };
      }
      return this.executePaymentWithExternalSigner(quote);
    }

    if (!this.config.secretKey) {
      return {
        success: false,
        error: `Payment required. Send ${quote.amount} ${quote.asset} to ${quote.paymentAddress}.`,
      };
    }

    // Secret key path: build + sign in one shot.
    return this.executePaymentWithSecretKey(quote);
  }

  /** Build, sign, submit, and confirm a payment using a secret key. */
  private async executePaymentWithSecretKey(
    quote: Quote,
  ): Promise<{ success: true; txHash: string } | { success: false; error: string }> {
    try {
      const result = await buildPaymentTransaction({
        sourceSecret: this.config.secretKey!,
        destination: quote.paymentAddress,
        // Quote amounts are in stroops; the stellar-sdk expects decimal
        // asset units (e.g. "0.1" USDC), so convert before building the tx.
        amount: stroopsToUnits(quote.amount),
        asset: quote.asset,
        assetIssuer: quote.assetIssuer,
        memo: quote.memo,
        network: quote.network,
        horizonUrl: this.getHorizonUrl(quote.network),
      });

      // Submit to Horizon via SDK server (not raw fetch)
      const server = createHorizonServer(quote.network);
      await server.submitTransaction(result.txXdr);

      logger.info('Payment submitted', {
        txHash: result.txHash,
        amount: quote.amount,
        asset: quote.asset,
      });

      const confirmed = await this.waitForConfirmation(result.txHash, quote);
      if (!confirmed) {
        return { success: false, error: 'Payment not confirmed within timeout' };
      }

      return { success: true, txHash: result.txHash };
    } catch (error) {
      return { success: false, error: `Payment failed: ${(error as Error).message}` };
    }
  }

  /**
   * Build an unsigned transaction, pass it to an external signer
   * (browser wallet extension, hardware wallet, or agent SDK), then submit
   * the signed XDR and wait for confirmation.
   */
  private async executePaymentWithExternalSigner(
    quote: Quote,
  ): Promise<{ success: true; txHash: string } | { success: false; error: string }> {
    try {
      // 1. Build the unsigned transaction
      const unsigned = await buildUnsignedPaymentTransaction({
        sourcePublicKey: this.config.publicKey!,
        destination: quote.paymentAddress,
        amount: stroopsToUnits(quote.amount),
        asset: quote.asset,
        assetIssuer: quote.assetIssuer,
        memo: quote.memo,
        network: quote.network,
        horizonUrl: this.getHorizonUrl(quote.network),
      });

      // 2. Hand the unsigned XDR to the external signer
      const signedXdr = await this.config.signTransaction!(unsigned.txXdr);

      // 3. Submit the signed transaction
      const server = createHorizonServer(quote.network);
      await server.submitTransaction(signedXdr);

      logger.info('Payment submitted (external signer)', {
        txHash: unsigned.txHash,
        amount: quote.amount,
        asset: quote.asset,
      });

      const confirmed = await this.waitForConfirmation(unsigned.txHash, quote);
      if (!confirmed) {
        return { success: false, error: 'Payment not confirmed within timeout' };
      }

      return { success: true, txHash: unsigned.txHash };
    } catch (error) {
      return { success: false, error: `External payment failed: ${(error as Error).message}` };
    }
  }

  // ── Helpers ─────────────────────────────────

  private async waitForConfirmation(txHash: string, quote: Quote): Promise<boolean> {
    const deadline = Date.now() + (this.config.paymentTimeout || 300_000);
    const horizonUrl = this.getHorizonUrl(quote.network);

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${horizonUrl}/transactions/${txHash}`);
        if (response.ok) {
          const txData = await response.json();
          if (txData.successful) return true;
        }
      } catch {
        // Transaction not found yet — keep waiting
      }
      await sleep(2000);
    }

    return false;
  }

  private getHorizonUrl(network: StellarNetwork): string {
    switch (network) {
      case 'mainnet':
        return 'https://horizon.stellar.org';
      case 'futurenet':
        return 'https://horizon-futurenet.stellar.org';
      case 'testnet':
      default:
        return 'https://horizon-testnet.stellar.org';
    }
  }

  /**
   * Parse SSE chunks from a fetch Response into an async generator.
   *
   * Yields `ChatCompletionStreamChunk` objects for each SSE data frame.
   * When the gateway sends a trailing `x402_receipt` event (streaming cost
   * info), it is stored in the provided `receiptRef` object so `callStream`
   * can return it together with the stream result.
   */
  private async *sseGenerator(
    response: globalThis.Response,
    receiptRef?: { receipt: PaymentReceipt | undefined },
  ): AsyncGenerator<ChatCompletionStreamChunk, void, unknown> {
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data);
            // Extract trailing receipt sent by the gateway after the stream
            if (parsed.x402_receipt && receiptRef) {
              receiptRef.receipt = parsed.x402_receipt as PaymentReceipt;
              continue;
            }
            const chunk = parsed as ChatCompletionStreamChunk;
            yield chunk;
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseReceiptHeader(header: string | null): PaymentReceipt | undefined {
    if (!header) return undefined;
    try {
      return JSON.parse(header);
    } catch {
      return undefined;
    }
  }
}

/**
 * Create a new x402 client instance.
 */
export function createX402Client(config: X402ClientConfig): X402Client {
  return new X402Client(config);
}
