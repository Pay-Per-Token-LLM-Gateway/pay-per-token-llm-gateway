/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotificationsService } from './notifications.service';
import {
  setPrismaClient,
  getInAppNotifications,
  markInAppRead,
  getUnreadCount,
} from '@x402/notifications';

jest.mock('@x402/database', () => ({
  prisma: {
    inAppNotification: {
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  },
}));

const mockPrisma = jest.requireMock('@x402/database').prisma as any;

const WALLET = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new NotificationsService();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should list notifications via the DB-backed handler', async () => {
    mockPrisma.inAppNotification.findMany.mockResolvedValue([
      {
        id: 'n1',
        providerId: WALLET,
        event: 'payment:verified',
        data: { amount: '1' },
        read: false,
        createdAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      },
    ]);
    mockPrisma.inAppNotification.count.mockResolvedValue(1);

    const result = await service.getNotifications(WALLET, { page: 1, limit: 50 });
    expect(result.notifications).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(mockPrisma.inAppNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerId: WALLET } }),
    );
  });

  it('should mark a notification as read', async () => {
    mockPrisma.inAppNotification.update.mockResolvedValue({ id: 'n1', read: true });

    const result = await service.markRead('n1');
    expect(result).toBe(true);
    expect(mockPrisma.inAppNotification.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { read: true },
    });
  });

  it('should get unread count', async () => {
    mockPrisma.inAppNotification.count.mockResolvedValue(3);

    const result = await service.getUnreadCount(WALLET);
    expect(result).toBe(3);
  });
});

describe('@x402/notifications in-memory fallback', () => {
  beforeEach(() => {
    // Reset the singleton by clearing the DB handles
    (setPrismaClient as any)(null);
  });

  afterAll(() => {
    (setPrismaClient as any)(null);
  });

  it('getInAppNotifications returns empty when nothing sent', async () => {
    const result = await getInAppNotifications('some-wallet');
    expect(result.notifications).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.unread).toBe(0);
  });

  it('markInAppRead returns false for unknown id', async () => {
    const result = await markInAppRead('missing');
    expect(result).toBe(false);
  });

  it('getUnreadCount returns 0 when empty', async () => {
    const count = await getUnreadCount('some-wallet');
    expect(count).toBe(0);
  });
});
