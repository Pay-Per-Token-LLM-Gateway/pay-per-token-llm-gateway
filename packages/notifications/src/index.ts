// ──────────────────────────────────────────────
// @x402/notifications — Email, webhook, in-app
// ──────────────────────────────────────────────

import type { NotificationChannel, NotificationEvent } from '@x402/types';
import { logger } from '@x402/logger';

export interface NotificationPayload {
  providerId: string;
  event: NotificationEvent;
  data: Record<string, unknown>;
}

export interface NotificationHandler {
  channel: NotificationChannel;
  send(payload: NotificationPayload): Promise<boolean>;
}

export interface InAppMessage {
  id: string;
  providerId: string;
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
  read: boolean;
}

// ── In-App Notification Handler (DB-backed with in-memory fallback) ─

type PrismaClient = {
  inAppNotification: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy: Record<string, string>;
      take: number;
      skip: number;
    }) => Promise<InAppMessage[]>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
  };
};

let prisma: PrismaClient | null = null;

/**
 * Set the Prisma client for DB-backed notifications.
 * Called during gateway bootstrap when DATABASE_URL is available.
 */
export function setPrismaClient(client: PrismaClient): void {
  prisma = client;
}

/** Check if DB-backed notifications are available */
function hasDb(): boolean {
  return prisma !== null;
}

const inAppQueue: InAppMessage[] = [];

export const inAppHandler: NotificationHandler = {
  channel: 'in_app',
  async send(payload) {
    const message: InAppMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      providerId: payload.providerId,
      event: payload.event,
      data: payload.data,
      timestamp: new Date().toISOString(),
      read: false,
    };

    // Persist to DB when available
    if (hasDb()) {
      try {
        await prisma!.inAppNotification.create({
          data: {
            providerId: payload.providerId,
            event: payload.event,
            data: payload.data,
            read: false,
          },
        });
        logger.info('In-app notification persisted', {
          providerId: payload.providerId,
          event: payload.event,
        });
        return true;
      } catch (error) {
        logger.error('Failed to persist in-app notification, falling back to in-memory', {
          error: String(error),
        });
      }
    }

    // In-memory fallback
    inAppQueue.unshift(message);
    if (inAppQueue.length > 1000) {
      inAppQueue.length = 1000;
    }

    logger.info('In-app notification (in-memory)', payload as unknown as Record<string, unknown>);
    return true;
  },
};

/** Get in-app notifications for a provider */
export async function getInAppNotifications(
  providerId: string,
  options: { page?: number; limit?: number; unreadOnly?: boolean } = {},
): Promise<{ notifications: InAppMessage[]; total: number; unread: number }> {
  const page = options.page || 1;
  const limit = options.limit || 50;
  const skip = (page - 1) * limit;

  if (hasDb()) {
    try {
      const where: Record<string, unknown> = { providerId };
      if (options.unreadOnly) {
        where.read = false;
      }

      const [notifications, total, unread] = await Promise.all([
        prisma!.inAppNotification.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip,
        }),
        prisma!.inAppNotification.count({ where: { providerId } }),
        prisma!.inAppNotification.count({ where: { providerId, read: false } }),
      ]);

      return {
        notifications: notifications.map((n: any) => ({
          id: n.id,
          providerId: n.providerId,
          event: n.event,
          data: n.data,
          read: n.read,
          timestamp: n.createdAt || n.timestamp,
        })),
        total,
        unread,
      };
    } catch (error) {
      logger.error('Failed to query DB notifications, falling back to in-memory', {
        error: String(error),
      });
    }
  }

  // In-memory fallback
  const filtered = inAppQueue.filter((m) => m.providerId === providerId);
  const total = filtered.length;
  const unread = filtered.filter((m) => !m.read).length;
  const notifications = filtered.slice(skip, skip + limit);

  return { notifications, total, unread };
}

/** Mark a notification as read */
export async function markInAppRead(messageId: string): Promise<boolean> {
  if (hasDb()) {
    try {
      await prisma!.inAppNotification.update({
        where: { id: messageId },
        data: { read: true },
      });
      return true;
    } catch (error) {
      logger.error('Failed to mark notification read in DB, falling back to in-memory', {
        error: String(error),
      });
    }
  }

  // In-memory fallback
  const msg = inAppQueue.find((m) => m.id === messageId);
  if (msg) {
    msg.read = true;
    return true;
  }
  return false;
}

/** Get unread count for a provider */
export async function getUnreadCount(providerId: string): Promise<number> {
  if (hasDb()) {
    try {
      return await prisma!.inAppNotification.count({
        where: { providerId, read: false },
      });
    } catch (error) {
      logger.error('Failed to query unread count from DB, falling back to in-memory', {
        error: String(error),
      });
    }
  }

  // In-memory fallback
  return inAppQueue.filter((m) => m.providerId === providerId && !m.read).length;
}

// ── Email Notification Handler ───────────────

export class EmailNotificationHandler implements NotificationHandler {
  channel: NotificationChannel = 'email';

  constructor(
    private options: {
      smtpHost?: string;
      smtpPort?: number;
      fromAddress?: string;
    } = {},
  ) {}

  async send(payload: NotificationPayload): Promise<boolean> {
    if (!this.options.smtpHost) {
      logger.warn(
        'Email notifications not configured — skipping',
        payload as unknown as Record<string, unknown>,
      );
      return false;
    }

    // In production, this would use nodemailer or similar.
    // Placeholder implementation.
    logger.info('Email notification (placeholder)', {
      to: `provider:${payload.providerId}`,
      subject: `x402 Gateway: ${payload.event}`,
      ...(payload as unknown as Record<string, unknown>),
    });

    return true;
  }
}

// ── Webhook Notification Handler ─────────────

export class WebhookNotificationHandler implements NotificationHandler {
  channel: NotificationChannel = 'webhook';

  constructor(
    private options: {
      retryCount?: number;
      retryDelayMs?: number;
    } = {},
  ) {}

  async send(payload: NotificationPayload, webhookUrl?: string): Promise<boolean> {
    if (!webhookUrl) {
      logger.warn(
        'No webhook URL configured — skipping',
        payload as unknown as Record<string, unknown>,
      );
      return false;
    }

    const maxRetries = this.options.retryCount || 3;
    const retryDelay = this.options.retryDelayMs || 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: payload.event,
            providerId: payload.providerId,
            data: payload.data,
            timestamp: new Date().toISOString(),
          }),
        });

        if (response.ok) {
          logger.info('Webhook sent successfully', { event: payload.event, webhookUrl });
          return true;
        }

        logger.warn('Webhook delivery failed', {
          event: payload.event,
          status: response.status,
          attempt,
        });
      } catch (error) {
        logger.warn('Webhook error', { event: payload.event, error: String(error), attempt });
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelay * attempt));
      }
    }

    logger.error('Webhook delivery failed after all retries', { event: payload.event });
    return false;
  }

  /**
   * Send a webhook with an optional HMAC-SHA256 signature header so the
   * receiver can verify the payload came from this gateway.
   *
   * Signature: hex(HMAC-SHA256(secret, rawBody)) sent as `X-x402-Signature`.
   */
  async sendWithSignature(
    payload: NotificationPayload,
    webhookUrl: string,
    secret?: string,
  ): Promise<boolean> {
    const maxRetries = this.options.retryCount || 3;
    const retryDelay = this.options.retryDelayMs || 1000;
    const body = JSON.stringify({
      event: payload.event,
      providerId: payload.providerId,
      data: payload.data,
      timestamp: new Date().toISOString(),
    });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) {
      const { createHmac } = await import('crypto');
      headers['X-x402-Signature'] = createHmac('sha256', secret).update(body).digest('hex');
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers,
          body,
          // Never let a misbehaving receiver stall payment processing.
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          logger.info('Signed webhook sent successfully', {
            event: payload.event,
            webhookUrl,
            signed: !!secret,
          });
          return true;
        }

        logger.warn('Signed webhook delivery failed', {
          event: payload.event,
          status: response.status,
          attempt,
        });
      } catch (error) {
        logger.warn('Signed webhook error', {
          event: payload.event,
          error: String(error),
          attempt,
        });
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelay * attempt));
      }
    }

    logger.error('Signed webhook delivery failed after all retries', { event: payload.event });
    return false;
  }
}

// ── Notification Dispatcher ──────────────────

export class NotificationDispatcher {
  private handlers: NotificationHandler[] = [];

  register(handler: NotificationHandler): void {
    this.handlers.push(handler);
  }

  async dispatch(payload: NotificationPayload): Promise<NotificationChannel[]> {
    const delivered: NotificationChannel[] = [];

    for (const handler of this.handlers) {
      try {
        const success = await handler.send(payload);
        if (success) delivered.push(handler.channel);
      } catch (error) {
        logger.error('Notification handler error', {
          channel: handler.channel,
          error: String(error),
        });
      }
    }

    return delivered;
  }
}

/** Default dispatcher instance */
export const dispatcher = new NotificationDispatcher();
dispatcher.register(inAppHandler);
