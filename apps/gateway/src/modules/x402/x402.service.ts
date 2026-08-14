import { Injectable, Inject } from '@nestjs/common';
import {
  generateQuote,
  verifyStellarPayment,
  generateReceipt,
  buildPaymentRequiredResponse,
  ReplayProtection,
  type RedisLike,
} from '@x402/x402-core';
import { getConfig } from '@x402/config';
import { logger } from '@x402/logger';
import { isPaymentUsedOnChain, recordPaymentOnChain, chargeEscrowOnChain } from './contract-client';
import type { Quote, PaymentVerification, PaymentReceipt, RouteConfig } from '@x402/types';
import type { PrismaClient } from '@x402/database';

@Injectable()
export class X402Service {
  private readonly replayProtection: ReplayProtection;

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    @Inject('REDIS') redisClient: RedisLike,
  ) {
    this.replayProtection = new ReplayProtection(redisClient);
  }

  /**
   * Generate a quote for a given route.
   */
  async generateQuoteForRoute(route: RouteConfig, estimatedTokens?: number): Promise<Quote> {
    const config = getConfig();

    // Look up the provider's wallet address from the database
    const provider = await this.prisma.provider.findUnique({
      where: { id: route.providerId },
    });
    const providerAddress = provider?.walletAddress || '';

    const quote = generateQuote({
      route,
      providerAddress,
      // In production the server binds 0.0.0.0 — quote URLs must point at a
      // public base URL (PUBLIC_GATEWAY_URL) or clients receive broken links.
      gatewayBaseUrl: config.publicBaseUrl || `http://${config.host}:${config.port}`,
      network: config.stellar.network,
      quoteExpirySeconds: config.payment.quoteExpirySeconds,
      usdcIssuer: config.payment.usdcIssuer,
      estimatedTokens,
      minPaymentAmount: config.payment.minPaymentAmount,
    });

    logger.info('Quote generated', { quoteId: quote.id, route: route.path, providerAddress });

    return quote;
  }

  /**
   * Build a 402 Payment Required response.
   */
  async build402Response(quote: Quote) {
    const config = getConfig();
    return buildPaymentRequiredResponse({
      quote,
      gatewayBaseUrl: config.publicBaseUrl || `http://${config.host}:${config.port}`,
    });
  }

  /**
   * Verify a Stellar payment.
   *
   * Uses two layers of verification:
   * 1. Primary: Horizon API for on-chain payment validation
   * 2. Secondary: Soroban payment-verifier contract for immutable audit trail
   */
  async verifyPayment(txHash: string, quote: Quote): Promise<PaymentVerification> {
    const config = getConfig();

    // Layer 1: Redis-backed atomic replay protection (fast, local). `claim`
    // uses SET NX so concurrent requests with the same hash race here and
    // exactly one wins — the foundation of single-use enforcement.
    if (!(await this.replayProtection.claim(txHash, config.redis.paymentCacheTtl))) {
      return {
        verified: false,
        txHash,
        payerAddress: '',
        amount: '0',
        asset: quote.asset,
        ledger: 0,
        timestamp: 0,
        failureReason: 'Payment already used (replay protection)',
      };
    }

    // Layer 1b: On-chain replay protection (immutable, cross-gateway)
    // This catches replays even if Redis data is lost
    const contractUsed = await isPaymentUsedOnChain(
      config.contracts.paymentVerifier,
      txHash,
      config.stellar.sorobanRpcUrl,
    );
    if (contractUsed) {
      // Extend the Redis claim so we don't query the contract again
      await this.replayProtection.markUsed(txHash, config.redis.paymentCacheTtl);
      return {
        verified: false,
        txHash,
        payerAddress: '',
        amount: '0',
        asset: quote.asset,
        ledger: 0,
        timestamp: 0,
        failureReason: 'Payment already used (on-chain replay protection)',
      };
    }

    // Layer 2: On-chain verification via Horizon
    const verification = await verifyStellarPayment({
      txHash,
      quote,
      horizonUrl: config.stellar.horizonUrl,
      sorobanRpcUrl: config.stellar.sorobanRpcUrl,
      networkPassphrase: config.stellar.networkPassphrase,
      minPaymentAmount: config.payment.minPaymentAmount,
    });

    if (verification.verified) {
      // Best-effort on-chain audit trail: record the verified payment on the
      // payment-verifier contract so replay protection and the immutable
      // audit trail survive Redis loss and work across gateway instances.
      if (config.payment.contractAdminSecret) {
        await recordPaymentOnChain({
          contractId: config.contracts.paymentVerifier,
          rpcUrl: config.stellar.sorobanRpcUrl,
          networkPassphrase: config.stellar.networkPassphrase,
          adminSecret: config.payment.contractAdminSecret,
          txHash,
          payer: verification.payerAddress,
          payee: quote.paymentAddress,
          amount: verification.amount,
          asset: verification.asset,
          timestamp: verification.timestamp,
          quoteId: quote.id,
        });
      }
    }

    return verification;
  }

  /**
   * Verify an escrow payment.
   *
   * Deducts prepaid balance from the credit-escrow Soroban contract.
   * If successful, generates a synthetic txHash for DB storage.
   */
  async verifyEscrowPayment(payerAddress: string, quote: Quote): Promise<PaymentVerification> {
    const config = getConfig();

    if (!config.payment.contractAdminSecret) {
      return {
        verified: false,
        txHash: `escrow:${quote.id}`,
        payerAddress,
        amount: quote.amount,
        asset: quote.asset,
        ledger: 0,
        timestamp: 0,
        failureReason: 'Escrow payments are disabled (no admin secret)',
      };
    }

    // Call the credit-escrow contract
    const result = await chargeEscrowOnChain({
      contractId: config.contracts.creditEscrow,
      rpcUrl: config.stellar.sorobanRpcUrl,
      networkPassphrase: config.stellar.networkPassphrase,
      adminSecret: config.payment.contractAdminSecret,
      payer: payerAddress,
      amount: quote.amount,
      quoteId: quote.id,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    // Use a synthetic hash that acts as a unique identifier for replay protection.
    // The prefix ensures it doesn't collide with any valid SHA-256 hash.
    const syntheticTxHash = `escrow:${quote.id}`;

    if (!result.charged) {
      return {
        verified: false,
        txHash: syntheticTxHash,
        payerAddress,
        amount: quote.amount,
        asset: quote.asset,
        ledger: 0,
        timestamp,
        failureReason: result.error || 'Failed to charge escrow balance',
      };
    }

    return {
      verified: true,
      txHash: syntheticTxHash,
      payerAddress,
      amount: quote.amount,
      asset: quote.asset,
      ledger: 0, // Soroban RPC doesn't currently easily expose the ledger of the specific invocation without parsing the whole meta
      timestamp,
    };
  }

  /**
   * Generate a payment receipt.
   */
  generateReceipt(verification: PaymentVerification, quote: Quote): PaymentReceipt {
    return generateReceipt(verification, quote);
  }

  /**
   * Validate that a quote hasn't expired.
   */
  isQuoteExpired(quote: Quote): boolean {
    return Date.now() / 1000 > quote.expiresAt;
  }
}
