import { Injectable } from '@nestjs/common';
import { prisma } from '@x402/database';
import {
  setPrismaClient,
  getInAppNotifications,
  markInAppRead,
  getUnreadCount,
} from '@x402/notifications';

@Injectable()
export class NotificationsService {
  constructor() {
    // Wire up the Prisma client for DB-backed notifications
    setPrismaClient(prisma as any);
  }

  async getNotifications(
    providerId: string,
    options: { page?: number; limit?: number; unreadOnly?: boolean } = {},
  ) {
    return getInAppNotifications(providerId, options);
  }

  async markRead(notificationId: string): Promise<boolean> {
    return markInAppRead(notificationId);
  }

  async getUnreadCount(providerId: string): Promise<number> {
    return getUnreadCount(providerId);
  }
}
