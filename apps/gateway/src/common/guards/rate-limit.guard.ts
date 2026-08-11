import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { getConfig } from '@x402/config';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@x402/database';

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    @Inject('REDIS') private readonly redis: Redis,
    @Inject('PRISMA') private readonly prisma: PrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const config = getConfig();

    // Identify the caller by IP only. Client-supplied headers (e.g.
    // x-caller-address) are never trusted — an attacker could rotate them to
    // bypass the limit entirely. Behind a reverse proxy, `request.ip` is
    // resolved via the Express `trust proxy` setting configured in main.ts.
    const callerId = request.ip || request.socket.remoteAddress || 'unknown';

    const txHash = request.headers['x-payment-hash'] as string | undefined;

    // The paid tier is only granted when the payment hash has actually been
    // CONFIRMED — the mere presence of a (possibly fake) header must never
    // raise the limit, or the paid tier is trivially spoofable.
    const paymentInfo = await this.isConfirmedPayment(txHash);

    if (paymentInfo) {
      // When RATE_LIMIT_BY_WALLET is enabled, key the paid tier by the
      // payer's Stellar wallet address instead of IP. This prevents
      // IP-rotation attacks on the paid tier when the gateway is directly
      // exposed without a reverse proxy.
      const paidCallerId =
        config.security.rateLimitByWallet && paymentInfo.payerAddress
          ? paymentInfo.payerAddress
          : callerId;

      // Confirmed payments get a higher, separate rate limit
      const paidWindow = config.redis.rateLimitWindow * 2; // e.g. 120s
      const paidMax = config.redis.rateLimitMax * 10; // e.g. 100 requests/window
      return this.checkLimit(paidCallerId, paidWindow, paidMax, 'paid');
    }

    // Unpaid requests: strict limit to prevent 402 quote-spam
    const unpaidWindow = config.redis.rateLimitWindow;
    const unpaidMax = config.redis.rateLimitMax;
    return this.checkLimit(callerId, unpaidWindow, unpaidMax, 'unpaid');
  }

  /** True when the header carries a txHash with a confirmed payment row. */
  private async isConfirmedPayment(
    txHash: string | undefined,
  ): Promise<{ id: string; payerAddress: string | null } | null> {
    if (!txHash || !/^[a-f0-9]{64}$/i.test(txHash)) return null;
    try {
      const payment = await this.prisma.payment.findFirst({
        where: { txHash, status: 'confirmed' },
        select: { id: true, payerAddress: true },
      });
      return payment;
    } catch (error) {
      this.logger.warn('Rate limit payment check failed, using unpaid tier', {
        error: String(error),
      });
      return null;
    }
  }

  private async checkLimit(
    callerId: string,
    windowSeconds: number,
    maxRequests: number,
    tier: 'paid' | 'unpaid',
  ): Promise<boolean> {
    try {
      const key = `x402:ratelimit:${tier}:${callerId}`;
      const allowed = await this.evalRateLimit(key, windowSeconds, maxRequests);

      if (!allowed) {
        throw new HttpException(
          {
            status: 429,
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Max ${maxRequests} ${tier} requests per ${windowSeconds}s.`,
            retryAfter: windowSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return true;
    } catch (error) {
      // Re-throw HTTP exceptions (like our 429) so they reach the client
      if (error instanceof HttpException) {
        throw error;
      }

      // Redis connectivity errors → fall through gracefully
      this.logger.warn('Rate limit check failed, allowing request', {
        callerId,
        tier,
        error: String(error),
      });
      return true;
    }
  }

  /**
   * Sliding window rate limit using a Redis sorted set with an atomic Lua script.
   */
  private async evalRateLimit(
    key: string,
    windowSeconds: number,
    maxRequests: number,
  ): Promise<boolean> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    const script = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local window_start = tonumber(ARGV[2])
      local member = ARGV[3]
      local max_requests = tonumber(ARGV[4])
      local ttl = tonumber(ARGV[5])

      -- Evict entries outside the sliding window
      redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

      -- Count remaining entries
      local count = redis.call('ZCARD', key)

      if count >= max_requests then
        return 0
      end

      -- Add current request
      redis.call('ZADD', key, now, member)
      redis.call('EXPIRE', key, ttl)

      return 1
    `;

    const member = `${now}-${Math.random().toString(36).slice(2, 9)}`;
    const ttl = windowSeconds + 10;

    const result = (await this.redis.eval(
      script,
      1,
      key,
      now.toString(),
      windowStart.toString(),
      member,
      maxRequests.toString(),
      ttl.toString(),
    )) as number;

    return result === 1;
  }
}
