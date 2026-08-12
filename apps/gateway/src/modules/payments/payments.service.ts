import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@x402/database';
import { logger } from '@x402/logger';
import type {
  Quote,
  PaymentVerification,
  PaymentReceipt,
  RouteConfig,
  PaymentRecord,
} from '@x402/types';

/** Serialized payment response with amount as string (for JSON-safe responses) */
export interface PaymentResponse {
  id: string;
  quoteId: string;
  txHash: string | null;
  payerAddress: string | null;
  amount: string;
  asset: string;
  status: string;
  verifiedAt: Date | null;
  routeId: string;
  providerId: string;
  createdAt: Date;
}

@Injectable()
export class PaymentsService {
  /**
   * Create a pending payment record when a quote is generated.
   */
  async createPendingPayment(quote: Quote, route: RouteConfig): Promise<void> {
    await prisma.payment.create({
      data: {
        quoteId: quote.id,
        routeId: route.id,
        providerId: route.providerId,
        txHash: null,
        payerAddress: null,
        amount: BigInt(quote.amount),
        asset: quote.asset,
        status: 'pending',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        receiptJson: quote as any,
      },
    });

    logger.info('Pending payment created', { quoteId: quote.id });
  }

  /**
   * Atomically confirm a payment after successful verification.
   *
   * Single-use guarantee: the update only touches rows that are still
   * un-consumed (`txHash IS NULL`) AND the schema enforces a partial unique
   * index on `Payment.txHash`. Concurrent requests for the same transaction
   * hash race here — exactly one claim wins; losers receive `null` and must
   * reject the request as a replay.
   *
   * Returns the receipt when THIS caller won the claim, or `null` when the
   * quote/hash was already consumed by another request.
   */
  async confirmPayment(
    quoteId: string,
    verification: PaymentVerification,
    routePath?: string,
  ): Promise<PaymentReceipt | null> {
    const receipt: PaymentReceipt = {
      id: quoteId,
      quoteId,
      txHash: verification.txHash,
      payerAddress: verification.payerAddress,
      amount: verification.amount,
      asset: verification.asset,
      route: routePath || '',
      status: 'confirmed',
      verifiedAt: new Date(verification.timestamp * 1000).toISOString(),
      ledger: verification.ledger,
    };

    try {
      const result = await prisma.payment.updateMany({
        where: { quoteId, txHash: null },
        data: {
          txHash: verification.txHash,
          payerAddress: verification.payerAddress,
          status: 'confirmed',
          verifiedAt: new Date(verification.timestamp * 1000),
          ledger: verification.ledger,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          receiptJson: receipt as any,
        },
      });

      if (result.count === 0) {
        // Already consumed (or the row never existed) — this caller lost the claim.
        logger.warn('Payment claim lost (already consumed)', {
          quoteId,
          txHash: verification.txHash,
        });
        return null;
      }

      logger.info('Payment confirmed', { quoteId, txHash: verification.txHash });
      return receipt;
    } catch (error) {
      // A unique-constraint violation on Payment.txHash means a concurrent
      // request claimed this hash first — single-use holds.
      const message = String(error instanceof Error ? error.message : error);
      if (/unique|constraint|duplicate/i.test(message)) {
        logger.warn('Payment claim lost (concurrent unique violation)', {
          quoteId,
          txHash: verification.txHash,
        });
        return null;
      }
      throw error;
    }
  }

  /**
   * Find a payment by quote ID.
   */
  async findByQuoteId(quoteId: string): Promise<PaymentRecord | null> {
    return prisma.payment.findFirst({ where: { quoteId } });
  }

  /**
   * Find a payment by transaction hash.
   */
  async findByTxHash(txHash: string): Promise<PaymentRecord | null> {
    return prisma.payment.findFirst({
      where: { txHash },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Find all payments belonging to the authenticated wallet's providers,
   * with pagination and filtering. Payments whose provider is not owned by
   * the caller are never returned (cross-tenant isolation).
   */
  async findAll(
    options: {
      providerId?: string;
      status?: string;
      payerAddress?: string;
      page?: number;
      limit?: number;
    } = {},
    ownerAddress: string,
  ): Promise<{
    data: PaymentResponse[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const { providerId, status, payerAddress } = options;

    // Only payments flowing to providers owned by the authenticated wallet.
    // Note: unlike getStats (which 404s on foreign providers), a foreign
    // providerId filter here silently returns an empty page — both are
    // leak-free, the difference is deliberate.
    const where: Record<string, unknown> = {
      provider: { walletAddress: ownerAddress },
    };
    if (providerId) where.providerId = providerId;
    if (status) where.status = status;
    if (payerAddress) where.payerAddress = payerAddress;

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payment.count({ where }),
    ]);

    // Serialize BigInt amounts to strings for JSON response
    const serialized: PaymentResponse[] = payments.map((p: any) => ({
      id: p.id,
      quoteId: p.quoteId,
      txHash: p.txHash,
      payerAddress: p.payerAddress,
      amount: p.amount.toString(),
      asset: p.asset,
      status: p.status,
      verifiedAt: p.verifiedAt,
      routeId: p.routeId,
      providerId: p.providerId,
      createdAt: p.createdAt,
    }));

    return {
      data: serialized,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Record the actual per-token cost after the LLM response.
   * For flat-rate routes this is a no-op (amount matches the quote).
   * For per-token routes this updates the receipt with actual cost and token count.
   */
  async recordActualCost(quoteId: string, actualCost: string, tokensUsed: number): Promise<void> {
    const payment = await prisma.payment.findFirst({ where: { quoteId } });
    if (!payment) return;

    const receiptJson = (payment.receiptJson as Record<string, unknown>) || {};
    const updatedReceipt = {
      ...receiptJson,
      actualCost,
      tokensUsed,
    };

    await prisma.payment.updateMany({
      where: { quoteId },
      data: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        receiptJson: updatedReceipt as any,
      },
    });

    logger.info('Actual cost recorded', {
      quoteId,
      actualCost,
      tokensUsed,
      paidAmount: payment.amount.toString(),
    });
  }

  /**
   * Get payment statistics for a provider owned by the authenticated wallet.
   */
  async getStats(providerId: string, ownerAddress: string) {
    // Ownership check first — statistics about another wallet's provider are
    // never exposed (and provider IDs can't be probed).
    const provider = await prisma.provider.findFirst({
      where: { id: providerId, walletAddress: ownerAddress },
    });
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);

    const [confirmed, total, totalRevenue] = await Promise.all([
      prisma.payment.count({ where: { providerId, status: 'confirmed' } }),
      prisma.payment.count({ where: { providerId } }),
      prisma.payment.aggregate({
        where: { providerId, status: 'confirmed' },
        _sum: { amount: true },
      }),
    ]);

    return {
      totalPayments: total,
      confirmedPayments: confirmed,
      failedPayments: total - confirmed,
      totalRevenue: totalRevenue._sum.amount?.toString() || '0',
    };
  }
}
