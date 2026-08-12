import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@x402/database';
import { logger } from '@x402/logger';

@Injectable()
export class AdminService {
  /**
   * Gateway statistics scoped to the authenticated wallet's providers.
   * Unscoped global counts were a cross-tenant information leak.
   */
  async getStats(ownerAddress: string) {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    const [providers, routes, payments, confirmedPayments] = await Promise.all([
      prisma.provider.count({ where: { walletAddress: ownerAddress } }),
      prisma.route.count({ where: { providerId: { in: providerIds } } }),
      prisma.payment.count({ where: { providerId: { in: providerIds } } }),
      prisma.payment.count({
        where: { providerId: { in: providerIds }, status: 'confirmed' },
      }),
    ]);

    return {
      providers,
      routes,
      totalPayments: payments,
      confirmedPayments,
      failedPayments: payments - confirmedPayments,
    };
  }

  /**
   * Resolve the provider IDs owned by the authenticated wallet. All audit
   * reads are scoped to this set — a wallet can never see another wallet's
   * audit entries.
   */
  private async getOwnedProviderIds(ownerAddress: string): Promise<string[]> {
    const providers = await prisma.provider.findMany({
      where: { walletAddress: ownerAddress },
      select: { id: true },
    });
    return providers.map((p: { id: string }) => p.id);
  }

  /**
   * Get audit logs belonging to the authenticated wallet's providers, with
   * pagination and filtering. Log entries are never leaked across wallets.
   */
  async getAuditLogs(
    ownerAddress: string,
    options: {
      page?: number;
      limit?: number;
      action?: string;
      entity?: string;
      providerId?: string;
    } = {},
  ): Promise<{
    data: Array<Record<string, unknown>>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = options.page || 1;
    const limit = options.limit || 50;
    const { action, entity } = options;

    // Ownership gate first — never construct a query for a resource the
    // caller cannot touch (404 instead of 403 so provider IDs can't be probed).
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    if (options.providerId && !providerIds.includes(options.providerId)) {
      throw new NotFoundException(`Provider ${options.providerId} not found`);
    }
    const where: Record<string, unknown> = options.providerId
      ? { providerId: options.providerId }
      : { providerId: { in: providerIds } };
    if (action) where.action = action;
    if (entity) where.entity = entity;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return { data: logs, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async writeAuditLog(data: {
    action: string;
    entity: string;
    entityId?: string;
    /** Provider the audit entry belongs to — used to scope reads to owners. */
    providerId?: string;
    actor?: string;
    details?: Record<string, unknown>;
    ip?: string;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.auditLog.create({ data: data as any });
  }

  /**
   * Expire pending payments whose quote window has passed. Called by the
   * hourly cleanup job — prevents unbounded accumulation of stale rows.
   * Returns the number of payments expired.
   */
  async expireStalePayments(quoteExpirySeconds: number): Promise<number> {
    const cutoff = new Date(Date.now() - quoteExpirySeconds * 1000);
    const result = await prisma.payment.updateMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      data: { status: 'expired' },
    });
    if (result.count > 0) {
      logger.info(`Expired ${result.count} stale pending payments`, { cutoff });
    }
    return result.count;
  }
}
