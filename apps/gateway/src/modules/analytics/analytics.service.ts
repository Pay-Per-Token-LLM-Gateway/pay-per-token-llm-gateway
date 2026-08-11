import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@x402/database';
import type { AnalyticsEvent } from '@x402/analytics';
import type { AnalyticsSummary, TimeSeriesDataPoint } from '@x402/types';

@Injectable()
export class AnalyticsService {
  /**
   * Resolve the provider IDs owned by the authenticated wallet. All analytics
   * reads are scoped to this set — a wallet can never see another wallet's
   * events.
   */
  private async getOwnedProviderIds(ownerAddress: string): Promise<string[]> {
    const providers = await prisma.provider.findMany({
      where: { walletAddress: ownerAddress },
      select: { id: true },
    });
    return providers.map((p: { id: string }) => p.id);
  }

  /** Record an unpaid (402) request event. */
  async recordUnpaidRequest(route: string, providerId: string) {
    await prisma.analyticsEvent.create({
      data: { type: 'request:unpaid', route, providerId },
    });
  }

  /** Record a paid request with amount and response time. */
  async recordPaidRequest(
    route: string,
    providerId: string,
    callerAddress: string,
    amount: string,
    asset: string,
    responseTime?: number,
  ) {
    await prisma.analyticsEvent.create({
      data: {
        type: 'request:paid',
        route,
        providerId,
        callerAddress,
        amount: BigInt(amount),
        asset,
        responseTime,
      },
    });
  }

  /** Record a verified payment event. */
  async recordPaymentVerified(
    route: string,
    providerId: string,
    callerAddress: string,
    amount: string,
    asset: string,
  ) {
    await prisma.analyticsEvent.create({
      data: {
        type: 'payment:verified',
        route,
        providerId,
        callerAddress,
        amount: BigInt(amount),
        asset,
      },
    });
  }

  /** Record a failed payment verification. */
  async recordPaymentFailed(route: string, providerId: string, callerAddress: string) {
    await prisma.analyticsEvent.create({
      data: {
        type: 'payment:failed',
        route,
        providerId,
        callerAddress,
      },
    });
  }

  /** Record a forwarded request with response time. */
  async recordForwarded(
    route: string,
    providerId: string,
    callerAddress: string,
    responseTime: number,
  ) {
    await prisma.analyticsEvent.create({
      data: {
        type: 'request:forwarded',
        route,
        providerId,
        callerAddress,
        responseTime,
      },
    });
  }

  /**
   * Get analytics summary using Prisma aggregation queries, scoped to the
   * authenticated wallet's providers.
   */
  async getSummary(ownerAddress: string, providerId?: string): Promise<AnalyticsSummary> {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    // Ownership gate first — never construct a query for a resource the
    // caller cannot touch (404 instead of 403 so provider IDs can't be probed).
    if (providerId && !providerIds.includes(providerId)) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }
    const where: Record<string, unknown> = providerId
      ? { providerId }
      : { providerId: { in: providerIds } };

    const [totalCount, paidCount, unpaidCount, revenueResult, avgResponseResult] =
      await Promise.all([
        prisma.analyticsEvent.count({ where }),
        prisma.analyticsEvent.count({
          where: { ...where, type: 'request:paid' },
        }),
        prisma.analyticsEvent.count({
          where: { ...where, type: 'request:unpaid' },
        }),
        // Sum of amounts for paid USDC events
        prisma.analyticsEvent.aggregate({
          where: {
            ...where,
            type: 'request:paid',
            asset: 'USDC',
            amount: { not: null },
          },
          _sum: { amount: true },
        }),
        // Average response time from forwarded events
        prisma.analyticsEvent.aggregate({
          where: {
            ...where,
            type: 'request:forwarded',
            responseTime: { not: null },
          },
          _avg: { responseTime: true },
        }),
      ]);

    // Top callers: group by callerAddress
    const topCallerRows = await prisma.analyticsEvent.groupBy({
      by: ['callerAddress'],
      where: {
        ...where,
        type: 'request:paid',
        callerAddress: { not: null },
      },
      _count: { id: true },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 10,
    });

    const topCallers = topCallerRows.map((row: any) => ({
      address: row.callerAddress ?? 'unknown',
      totalSpent: (row._sum.amount || 0n).toString(),
      requestCount: row._count.id,
    }));

    // Top routes: group by route
    const topRouteRows = await prisma.analyticsEvent.groupBy({
      by: ['route'],
      where: { ...where, type: 'request:paid' },
      _count: { id: true },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 10,
    });

    const topRoutes = topRouteRows.map((row: any) => ({
      path: row.route,
      requestCount: row._count.id,
      revenue: (row._sum.amount || 0n).toString(),
    }));

    return {
      totalRequests: totalCount,
      paidRequests: paidCount,
      unpaidRequests: unpaidCount,
      totalRevenue: (revenueResult._sum.amount || 0n).toString(),
      revenueAsset: 'USDC',
      averageResponseTime: Math.round(avgResponseResult._avg.responseTime || 0),
      successRate: totalCount > 0 ? Math.round((paidCount / totalCount) * 10000) / 100 : 0,
      topCallers,
      topRoutes,
    };
  }

  /**
   * Get time-series data using Prisma queries with time bucketing, scoped to
   * the authenticated wallet's providers.
   */
  async getTimeSeries(
    providerId: string,
    ownerAddress: string,
    intervalMinutes = 60,
    durationHours = 24,
  ): Promise<TimeSeriesDataPoint[]> {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    if (!providerIds.includes(providerId)) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    const now = new Date();
    const startTime = new Date(now.getTime() - durationHours * 60 * 60 * 1000);

    // Build time buckets (zero-filled)
    const intervalMs = intervalMinutes * 60 * 1000;
    const buckets: Map<number, TimeSeriesDataPoint> = new Map();

    for (let t = startTime.getTime(); t <= now.getTime(); t += intervalMs) {
      buckets.set(t, {
        timestamp: new Date(t).toISOString(),
        paidRequests: 0,
        unpaidRequests: 0,
        revenue: '0',
        failedVerifications: 0,
      });
    }

    // Fetch aggregated events in the time window using SQL bucketing
    const rawResults = await prisma.$queryRaw<
      { bucket: Date; type: string; count: number; revenue: string }[]
    >`
      SELECT 
        to_timestamp(floor(extract(epoch from "createdAt") / (${intervalMinutes} * 60)) * (${intervalMinutes} * 60)) AT TIME ZONE 'UTC' as bucket,
        type,
        COUNT(*)::integer as count,
        SUM(COALESCE(amount, 0))::text as revenue
      FROM "AnalyticsEvent"
      WHERE "providerId" = ${providerId} AND "createdAt" >= ${startTime}
      GROUP BY bucket, type
      ORDER BY bucket ASC
    `;

    // Fill buckets from SQL results
    for (const row of rawResults) {
      const bucketTime = row.bucket.getTime();
      const bucket = buckets.get(bucketTime);
      if (!bucket) continue;

      switch (row.type) {
        case 'request:paid':
          bucket.paidRequests = row.count;
          bucket.revenue = row.revenue;
          break;
        case 'request:unpaid':
          bucket.unpaidRequests = row.count;
          break;
        case 'payment:failed':
          bucket.failedVerifications = row.count;
          break;
      }
    }

    return Array.from(buckets.values()).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  /**
   * Get raw events for audit/debugging, scoped to the authenticated wallet's
   * providers.
   */
  async getEvents(
    ownerAddress: string,
    filter?: {
      providerId?: string;
      type?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<AnalyticsEvent[]> {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    const where: Record<string, unknown> = filter?.providerId
      ? { providerId: filter.providerId }
      : { providerId: { in: providerIds } };
    if (filter?.providerId && !providerIds.includes(filter.providerId)) {
      throw new NotFoundException(`Provider ${filter.providerId} not found`);
    }
    if (filter?.type) where.type = filter.type;

    const rows = await prisma.analyticsEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: filter?.offset || 0,
      take: filter?.limit || 100,
    });

    return rows.map((r: any) => ({
      type: r.type as AnalyticsEvent['type'],
      route: r.route,
      providerId: r.providerId,
      callerAddress: r.callerAddress || undefined,
      amount: r.amount?.toString() || undefined,
      asset: r.asset || undefined,
      responseTime: r.responseTime || undefined,
    }));
  }
}
