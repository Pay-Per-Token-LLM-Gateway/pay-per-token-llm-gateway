import { Injectable } from '@nestjs/common';
import { prisma } from '@x402/database';
import { LoadBalancerService } from '../load-balancer/load-balancer.service';

@Injectable()
export class AdminService {
  constructor(private readonly loadBalancerService: LoadBalancerService) {}

  async getHealth() {
    return {
      status: 'ok' as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '0.1.0',
    };
  }

  async getStats() {
    const [providers, routes, payments, confirmedPayments] = await Promise.all([
      prisma.provider.count(),
      prisma.route.count(),
      prisma.payment.count(),
      prisma.payment.count({ where: { status: 'confirmed' } }),
    ]);

    return {
      providers,
      routes,
      totalPayments: payments,
      confirmedPayments,
      failedPayments: payments - confirmedPayments,
    };
  }

  async getAuditLogs(
    options: {
      page?: number;
      limit?: number;
      action?: string;
      entity?: string;
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
    const where: Record<string, unknown> = {};
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
    actor?: string;
    details?: Record<string, unknown>;
    ip?: string;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.auditLog.create({ data: data as any });
  }

  /**
   * Get load balancer health status for all active routes.
   */
  async getLoadBalancerHealth(): Promise<Record<string, unknown>[]> {
    const routes = await prisma.route.findMany({
      where: { active: true },
      include: { provider: { select: { active: true, name: true } } },
    });

    const lbEntries = routes
      .filter((r) => r.provider.active)
      .map((r) => ({
        route: {
          id: r.id,
          providerId: r.providerId,
          path: r.path,
          upstreamUrl: r.upstreamUrl,
          model: r.model,
          pricingModel: r.pricingModel,
          flatPrice: r.flatPrice ?? undefined,
          perTokenPrice: r.perTokenPrice ?? undefined,
          acceptedAssets: r.acceptedAssets,
          rateLimit: r.rateLimit,
          active: r.active,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        },
        weight: r.weight ?? 1,
      }));

    return this.loadBalancerService.getHealthStatus(
      lbEntries as Parameters<LoadBalancerService['getHealthStatus']>[0],
    ) as unknown as Record<string, unknown>[];
  }
}
