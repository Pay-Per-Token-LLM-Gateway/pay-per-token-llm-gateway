import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';

// Mock @x402/database
jest.mock('@x402/database', () => ({
  prisma: {
    analyticsEvent: {
      create: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
    },
    provider: {
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}));

import { prisma } from '@x402/database';
import { NotFoundException } from '@nestjs/common';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

const route = '/v1/chat/completions';
const providerId = 'provider-1';
const callerAddress = 'GB4YJON6574K74SGHSKHPMBJDJPLBPYN4HPGGN2J5RFKMSNFSWLBYFRL';
const OWNER = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';
const OTHER_OWNER = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK4G';

/** The wallet owns provider-1 and provider-2 (provider-3 belongs to someone else). */
function mockOwnedProviders(ids: string[] = ['provider-1', 'provider-2']) {
  (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue(ids.map((id) => ({ id })));
}

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AnalyticsService],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);

    jest.clearAllMocks();
  });

  describe('recordUnpaidRequest', () => {
    it('creates an unpaid request event', async () => {
      (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({ id: 'e1' });

      await service.recordUnpaidRequest(route, providerId);

      expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith({
        data: { type: 'request:unpaid', route, providerId },
      });
    });
  });

  describe('recordPaidRequest', () => {
    it('creates a paid request event with response time', async () => {
      (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({ id: 'e1' });

      await service.recordPaidRequest(route, providerId, callerAddress, '1000000', 'USDC', 250);

      expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith({
        data: {
          type: 'request:paid',
          route,
          providerId,
          callerAddress,
          amount: BigInt('1000000'),
          asset: 'USDC',
          responseTime: 250,
        },
      });
    });

    it('creates a paid request event without response time', async () => {
      (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({ id: 'e1' });

      await service.recordPaidRequest(route, providerId, callerAddress, '500000', 'USDC');

      expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith({
        data: {
          type: 'request:paid',
          route,
          providerId,
          callerAddress,
          amount: BigInt('500000'),
          asset: 'USDC',
          responseTime: undefined,
        },
      });
    });
  });

  describe('recordPaymentVerified', () => {
    it('creates a payment verified event', async () => {
      (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({ id: 'e1' });

      await service.recordPaymentVerified(route, providerId, callerAddress, '750000', 'USDC');

      expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith({
        data: {
          type: 'payment:verified',
          route,
          providerId,
          callerAddress,
          amount: BigInt('750000'),
          asset: 'USDC',
        },
      });
    });
  });

  describe('recordPaymentFailed', () => {
    it('creates a payment failed event', async () => {
      (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({ id: 'e1' });

      await service.recordPaymentFailed(route, providerId, callerAddress);

      expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith({
        data: { type: 'payment:failed', route, providerId, callerAddress },
      });
    });
  });

  describe('recordForwarded', () => {
    it('creates a forwarded request event', async () => {
      (mockPrisma.analyticsEvent.create as jest.Mock).mockResolvedValue({ id: 'e1' });

      await service.recordForwarded(route, providerId, callerAddress, 320);

      expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith({
        data: {
          type: 'request:forwarded',
          route,
          providerId,
          callerAddress,
          responseTime: 320,
        },
      });
    });
  });

  describe('getSummary', () => {
    it('returns a summary with provider filter, top callers and top routes', async () => {
      mockOwnedProviders();
      (mockPrisma.analyticsEvent.count as jest.Mock)
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(60) // paid
        .mockResolvedValueOnce(40); // unpaid
      (mockPrisma.analyticsEvent.aggregate as jest.Mock)
        .mockResolvedValueOnce({ _sum: { amount: BigInt('50000000') } }) // revenue
        .mockResolvedValueOnce({ _avg: { responseTime: 750 } }); // avg response time
      (mockPrisma.analyticsEvent.groupBy as jest.Mock)
        .mockResolvedValueOnce([
          {
            callerAddress,
            _sum: { amount: BigInt('30000000') },
            _count: { id: 10 },
          },
          {
            callerAddress: null,
            _sum: { amount: null },
            _count: { id: 2 },
          },
        ])
        .mockResolvedValueOnce([
          {
            route,
            _count: { id: 50 },
            _sum: { amount: BigInt('40000000') },
          },
        ]);

      const summary = await service.getSummary(OWNER, providerId);

      expect(mockPrisma.provider.findMany).toHaveBeenCalledWith({
        where: { walletAddress: OWNER },
        select: { id: true },
      });
      expect(mockPrisma.analyticsEvent.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { providerId } }),
      );
      expect(summary.totalRequests).toBe(100);
      expect(summary.paidRequests).toBe(60);
      expect(summary.unpaidRequests).toBe(40);
      expect(summary.totalRevenue).toBe('50000000');
      expect(summary.revenueAsset).toBe('USDC');
      expect(summary.averageResponseTime).toBe(750);
      expect(summary.successRate).toBe(60);
      expect(summary.topCallers).toEqual([
        { address: callerAddress, totalSpent: '30000000', requestCount: 10 },
        { address: 'unknown', totalSpent: '0', requestCount: 2 },
      ]);
      expect(summary.topRoutes).toEqual([{ path: route, requestCount: 50, revenue: '40000000' }]);
    });

    it('returns empty defaults when the wallet owns no providers and no provider filter', async () => {
      mockOwnedProviders([]);
      (mockPrisma.analyticsEvent.count as jest.Mock)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      (mockPrisma.analyticsEvent.aggregate as jest.Mock)
        .mockResolvedValueOnce({ _sum: { amount: null } })
        .mockResolvedValueOnce({ _avg: { responseTime: null } });
      (mockPrisma.analyticsEvent.groupBy as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const summary = await service.getSummary(OWNER);

      // Scoped to an empty owned-provider set → no cross-tenant leakage.
      expect(mockPrisma.analyticsEvent.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { providerId: { in: [] } } }),
      );
      expect(summary.totalRequests).toBe(0);
      expect(summary.paidRequests).toBe(0);
      expect(summary.unpaidRequests).toBe(0);
      expect(summary.totalRevenue).toBe('0');
      expect(summary.averageResponseTime).toBe(0);
      expect(summary.successRate).toBe(0);
      expect(summary.topCallers).toEqual([]);
      expect(summary.topRoutes).toEqual([]);
    });

    it('throws NotFoundException for a provider the wallet does not own', async () => {
      mockOwnedProviders(['provider-1']);

      await expect(service.getSummary(OTHER_OWNER, 'provider-3')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.analyticsEvent.count).not.toHaveBeenCalled();
    });
  });

  describe('getTimeSeries', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('builds buckets and aggregates events into them using SQL', async () => {
      mockOwnedProviders();
      const now = new Date('2026-08-10T12:00:00.000Z');
      jest.useFakeTimers({ now });

      const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const start = startTime.getTime();
      const hour = 60 * 60 * 1000;

      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([
        { bucket: new Date(start + hour), type: 'request:paid', count: 2, revenue: '1000000' },
        { bucket: new Date(start + 2 * hour), type: 'request:unpaid', count: 1, revenue: '0' },
        { bucket: new Date(start + 3 * hour), type: 'payment:failed', count: 1, revenue: '0' },
      ]);

      const series = await service.getTimeSeries(providerId, OWNER, 60, 24);

      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      expect(mockPrisma.analyticsEvent.findMany).not.toHaveBeenCalled();
      expect(series).toHaveLength(25);

      const bucket1 = series.find((p) => p.timestamp === new Date(start + hour).toISOString());
      expect(bucket1?.paidRequests).toBe(2);
      expect(bucket1?.revenue).toBe('1000000');
      expect(bucket1?.unpaidRequests).toBe(0);

      const bucket2 = series.find((p) => p.timestamp === new Date(start + 2 * hour).toISOString());
      expect(bucket2?.unpaidRequests).toBe(1);

      const bucket3 = series.find((p) => p.timestamp === new Date(start + 3 * hour).toISOString());
      expect(bucket3?.failedVerifications).toBe(1);
      expect(bucket3?.paidRequests).toBe(0);

      // Sorted chronologically
      const timestamps = series.map((p) => p.timestamp);
      expect([...timestamps].sort()).toEqual(timestamps);
    });

    it('throws NotFoundException for a provider the wallet does not own', async () => {
      mockOwnedProviders(['provider-1']);

      await expect(service.getTimeSeries('provider-3', OTHER_OWNER, 60, 24)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.analyticsEvent.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getEvents', () => {
    it('returns mapped events with filters', async () => {
      mockOwnedProviders();
      (mockPrisma.analyticsEvent.findMany as jest.Mock).mockResolvedValue([
        {
          type: 'request:paid',
          route,
          providerId,
          callerAddress,
          amount: BigInt('100'),
          asset: 'USDC',
          responseTime: 42,
        },
        {
          type: 'request:unpaid',
          route,
          providerId,
          callerAddress: null,
          amount: null,
          asset: null,
          responseTime: null,
        },
      ]);

      const events = await service.getEvents(OWNER, {
        providerId,
        type: 'request:paid',
        limit: 5,
        offset: 10,
      });

      expect(mockPrisma.analyticsEvent.findMany).toHaveBeenCalledWith({
        where: { providerId, type: 'request:paid' },
        orderBy: { createdAt: 'desc' },
        skip: 10,
        take: 5,
      });
      expect(events).toEqual([
        {
          type: 'request:paid',
          route,
          providerId,
          callerAddress,
          amount: '100',
          asset: 'USDC',
          responseTime: 42,
        },
        {
          type: 'request:unpaid',
          route,
          providerId,
          callerAddress: undefined,
          amount: undefined,
          asset: undefined,
          responseTime: undefined,
        },
      ]);
    });

    it('uses default pagination when no filter is provided', async () => {
      mockOwnedProviders([]);
      (mockPrisma.analyticsEvent.findMany as jest.Mock).mockResolvedValue([]);

      const events = await service.getEvents(OWNER);

      expect(mockPrisma.analyticsEvent.findMany).toHaveBeenCalledWith({
        where: { providerId: { in: [] } },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 100,
      });
      expect(events).toEqual([]);
    });

    it('throws NotFoundException when filtering by a provider the wallet does not own', async () => {
      mockOwnedProviders(['provider-1']);

      await expect(service.getEvents(OTHER_OWNER, { providerId: 'provider-3' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.analyticsEvent.findMany).not.toHaveBeenCalled();
    });
  });
});
