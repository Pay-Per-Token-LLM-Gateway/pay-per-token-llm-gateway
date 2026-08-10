import {
  Controller,
  All,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { ProxyService } from './proxy.service';
import { X402Service } from '../x402/x402.service';
import { RoutesService } from '../routes/routes.service';
import { PaymentsService } from '../payments/payments.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AdminService } from '../admin/admin.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { chatCompletionRequestSchema, txHashSchema } from '@x402/validation';
import { calculatePrice, comparePayment } from '@x402/x402-core';
import { logger } from '@x402/logger';
import { generateId } from '@x402/shared';
import type { ChatCompletionRequest, PaymentRecord, Quote, RouteConfig } from '@x402/types';

@ApiTags('proxy')
@Controller()
@UseGuards(RateLimitGuard)
export class ProxyController {
  constructor(
    private readonly proxyService: ProxyService,
    private readonly x402Service: X402Service,
    private readonly routesService: RoutesService,
    private readonly paymentsService: PaymentsService,
    private readonly analyticsService: AnalyticsService,
    private readonly adminService: AdminService,
    private readonly webhooksService: WebhooksService,
  ) {}

  /**
   * Main proxy endpoint — catches all LLM API requests.
   *
   * Flow:
   * 1. Validate the request body
   * 2. Look up the route for the requested model + path
   * 3. If no payment header: generate quote (with token estimate for per-token), store pending payment, return 402
   * 4. If payment: verify on-chain, then:
   *    - stream=true → pipe SSE stream from upstream to client
   *    - stream=false → forward, collect full response, calculate actual cost for per-token, return JSON
   */
  @All('chat/completions')
  @HttpCode(HttpStatus.OK)
  async handleChatCompletion(@Req() req: Request, @Res() res: Response) {
    const traceId = generateId();
    const startTime = Date.now();

    try {
      // 1. Validate request
      const parseResult = chatCompletionRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new BadRequestException({
          status: 400,
          error: 'Bad Request',
          message: 'Invalid chat completion request',
          details: parseResult.error.flatten(),
        });
      }
      const body = parseResult.data;
      const model = body.model;

      // 2. Look up the route for the requested model. Path normalization
      // (stripping the gateway prefix and matching `/v1` conventions) is
      // handled inside RoutesService so the matching logic stays in one place.
      const route = await this.routesService.findByPathAndModel(req.path, model);
      if (!route) {
        return res.status(404).json({
          status: 404,
          error: 'Not Found',
          message: `No route configured for model: ${model}`,
        });
      }

      // 3. Check for payment header. When present it must be a well-formed
      // 64-char hex transaction hash — reject garbage (and multi-value header
      // arrays) before it reaches Redis keys or Horizon URL paths.
      const txHash = req.headers['x-payment-hash'] as string | undefined;
      if (txHash !== undefined) {
        const txParse = txHashSchema.safeParse(txHash);
        if (!txParse.success) {
          return res.status(400).json({
            status: 400,
            error: 'Bad Request',
            message: 'Invalid X-Payment-Hash header: expected a 64-character hexadecimal string',
          });
        }
      }
      if (!txHash) {
        return this.handle402Response(res, route, traceId, model, body);
      }

      // 4. Verify payment (includes cross-route replay protection)
      const verified = await this.verifyAndConfirmPayment(txHash, route, res, traceId);
      if (!verified) {
        return; // 402 error response already sent
      }

      // 5. Resolve upstream API key
      const upstreamApiKey =
        process.env[`UPSTREAM_API_KEY_${route.providerId.toUpperCase().replace(/-/g, '_')}`];
      const payment = await this.paymentsService.findByTxHash(txHash);

      if (body.stream) {
        return this.handleStreamingForward(
          res,
          body,
          route,
          txHash,
          upstreamApiKey,
          payment,
          traceId,
          startTime,
        );
      }

      return this.handleNonStreamingForward(
        res,
        body,
        route,
        txHash,
        upstreamApiKey,
        payment,
        traceId,
        startTime,
      );
    } catch (error) {
      logger.error('Proxy error', { traceId, error: String(error) });

      if (error instanceof BadRequestException) {
        return res.status(400).json({
          status: 400,
          error: 'Bad Request',
          message: error.message,
        });
      }

      return res.status(502).json({
        status: 502,
        error: 'Bad Gateway',
        message: 'Upstream LLM request failed',
      });
    }
  }

  // ── Helper methods ───────────────────────────

  /**
   * Send a 402 Payment Required response.
   * For per-token routes, estimates cost based on request max_tokens.
   */
  private async handle402Response(
    res: Response,
    route: RouteConfig,
    traceId: string,
    model: string,
    body: ChatCompletionRequest,
  ) {
    logger.info('402: Payment required', { traceId, model });

    // For per-token pricing, estimate from the request's max_tokens
    const estimatedTokens =
      route.pricingModel === 'per_token' ? body.max_tokens || undefined : undefined;

    const quote = await this.x402Service.generateQuoteForRoute(route, estimatedTokens);
    const payment402 = await this.x402Service.build402Response(quote);

    await this.paymentsService.createPendingPayment(quote, route);
    await this.analyticsService.recordUnpaidRequest(route.path, route.providerId);

    await this.adminService.writeAuditLog({
      action: 'quote_generated',
      entity: 'quote',
      entityId: quote.id,
      providerId: route.providerId,
      actor: 'system',
      details: {
        model,
        route: route.path,
        amount: quote.amount,
        pricingModel: route.pricingModel,
        estimatedTokens,
        traceId,
      },
    });

    return res.status(402).json(payment402);
  }

  /**
   * Verify payment on-chain and confirm it. Returns true if verified.
   */
  private async verifyAndConfirmPayment(
    txHash: string,
    route: RouteConfig,
    res: Response,
    traceId: string,
  ): Promise<boolean> {
    logger.info('Verifying payment', { traceId, txHash });

    const existingPayment = await this.paymentsService.findByTxHash(txHash);

    // SECURITY — single-use invariant. A confirmed payment row means this
    // txHash has already been consumed; it must never grant access a second
    // time. Previously a confirmed row on the SAME route short-circuited to
    // `true`, letting callers pay once and replay the hash indefinitely for
    // unlimited LLM access (and bypassing Redis/on-chain replay protection,
    // which were only consulted for not-yet-confirmed payments). Cross-route
    // replays are rejected first for a clearer message; same-route replays
    // are rejected here — the DB row is evidence of consumption, never proof
    // of freshness.
    if (existingPayment?.status === 'confirmed') {
      if (existingPayment.routeId !== route.id) {
        logger.warn('Cross-route replay attempt', {
          traceId,
          txHash,
          existingRoute: existingPayment.routeId,
          requestedRoute: route.id,
        });
        res.status(402).json({
          status: 402,
          error: 'Payment Required',
          message: 'This payment was made for a different route. A new payment is required.',
        });
        return false;
      }

      logger.warn('Payment replay attempt (hash already used)', {
        traceId,
        txHash,
        routeId: existingPayment.routeId,
      });
      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: 'This payment has already been used. A new payment is required.',
      });
      return false;
    }

    // Use the original quote from the pending payment, or generate a new one.
    // CRITICAL: if the original quote has expired, reject even if the payment
    // was technically on-chain — the quote window is a security boundary.
    const storedQuote = existingPayment?.receiptJson
      ? (existingPayment.receiptJson as Quote)
      : null;

    if (storedQuote && this.x402Service.isQuoteExpired(storedQuote)) {
      logger.warn('Payment made with expired quote', {
        traceId,
        txHash,
        quoteId: storedQuote.id,
        expiresAt: storedQuote.expiresAt,
        now: Date.now() / 1000,
      });
      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: 'The payment quote has expired. Please request a new quote and pay again.',
      });
      return false;
    }

    // If no stored quote exists, generate one for verification.
    // (This handles the case where a payment arrives without a prior 402 quote.)
    const quoteForVerification =
      storedQuote ?? (await this.x402Service.generateQuoteForRoute(route));

    const verification = await this.x402Service.verifyPayment(txHash, quoteForVerification);

    if (!verification.verified) {
      logger.warn('Payment verification failed', {
        traceId,
        txHash,
        reason: verification.failureReason,
      });
      await this.adminService.writeAuditLog({
        action: 'payment_verification_failed',
        entity: 'payment',
        entityId: txHash,
        providerId: route.providerId,
        actor: verification.payerAddress,
        details: {
          reason: verification.failureReason,
          route: route.path,
          traceId,
        },
      });

      // Notify provider of verification failure
      this.webhooksService
        .notifyVerificationFailed(route.providerId, {
          txHash,
          reason: verification.failureReason || 'Unknown reason',
        })
        .catch((err) =>
          logger.error('Webhook notifyVerificationFailed error', { traceId, error: String(err) }),
        );

      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: `Payment verification failed: ${verification.failureReason}`,
      });
      return false;
    }

    // Atomically claim the payment. `confirmPayment` returns null when a
    // concurrent request already consumed this hash (single-use invariant)
    // — in that case the caller must NOT receive LLM access.
    const claimResult = existingPayment
      ? await this.paymentsService.confirmPayment(existingPayment.quoteId, verification)
      : await (async () => {
          await this.paymentsService.createPendingPayment(quoteForVerification, route);
          return this.paymentsService.confirmPayment(quoteForVerification.id, verification);
        })();

    if (!claimResult) {
      logger.warn('Payment replay attempt (claim lost to concurrent request)', {
        traceId,
        txHash,
      });
      res.status(402).json({
        status: 402,
        error: 'Payment Required',
        message: 'This payment has already been used. A new payment is required.',
      });
      return false;
    }

    await this.adminService.writeAuditLog({
      action: 'payment_verified',
      entity: 'payment',
      entityId: txHash,
      providerId: route.providerId,
      actor: verification.payerAddress,
      details: {
        amount: verification.amount,
        asset: verification.asset,
        route: route.path,
        traceId,
      },
    });

    // Notify provider of payment received
    this.webhooksService
      .notifyPaymentReceived(route.providerId, {
        txHash,
        amount: verification.amount || '0',
        asset: verification.asset || 'USDC',
        payerAddress: verification.payerAddress || 'unknown',
      })
      .catch((err) =>
        logger.error('Webhook notifyPaymentReceived error', { traceId, error: String(err) }),
      );

    return true;
  }

  /**
   * Forward a streaming request: pipe SSE chunks from upstream to client.
   * For per-token routes, calculates actual cost from final SSE usage chunk.
   */
  private async handleStreamingForward(
    res: Response,
    body: ChatCompletionRequest,
    route: RouteConfig,
    txHash: string,
    apiKey: string | undefined,
    payment: PaymentRecord | null,
    traceId: string,
    startTime: number,
  ) {
    logger.info('Forwarding streaming request to upstream', {
      traceId,
      model: body.model,
      upstreamUrl: route.upstreamUrl,
      pricingModel: route.pricingModel,
    });

    res.setHeader('X-Request-Trace-Id', traceId);

    // Pipe upstream SSE stream to client; extract tokens for per-token pricing
    const forwardResult = await this.proxyService.forwardBalancedStreamRequest(
      body,
      route,
      res,
      apiKey,
      traceId,
      async (totalTokens) => {
        const streamDuration = Date.now() - startTime;

        // Calculate actual cost for per-token pricing
        const costResult = await this.applyMeteredPricing(
          route,
          payment,
          totalTokens,
          res,
          traceId,
        );

        await this.analyticsService.recordPaidRequest(
          route.path,
          route.providerId,
          payment?.payerAddress || 'unknown',
          costResult.actualCost,
          payment?.asset || 'USDC',
          streamDuration,
        );
      },
    );

    await this.adminService.writeAuditLog({
      action: 'request_forwarded_stream',
      entity: 'request',
      entityId: traceId,
      providerId: route.providerId,
      actor: payment?.payerAddress || 'unknown',
      details: {
        model: body.model,
        route: route.path,
        txHash,
        traceId,
        upstreamUrl: forwardResult.upstreamUrl,
      },
    });
  }

  /**
   * Forward a non-streaming request: collect full response and return as JSON.
   * For per-token routes, calculates actual cost from response usage.total_tokens.
   */
  private async handleNonStreamingForward(
    res: Response,
    body: ChatCompletionRequest,
    route: RouteConfig,
    txHash: string,
    apiKey: string | undefined,
    payment: PaymentRecord | null,
    traceId: string,
    _startTime: number,
  ) {
    logger.info('Forwarding request to upstream', {
      traceId,
      model: body.model,
      upstreamUrl: route.upstreamUrl,
      pricingModel: route.pricingModel,
    });

    const { response, responseTime, upstreamUrl } = await this.proxyService.forwardBalancedRequest(
      body,
      route,
      apiKey,
      traceId,
    );

    // Calculate actual cost for per-token pricing
    const tokensUsed = response.usage?.total_tokens;
    const costResult = await this.applyMeteredPricing(route, payment, tokensUsed, res, traceId);

    await this.analyticsService.recordPaidRequest(
      route.path,
      route.providerId,
      payment?.payerAddress || 'unknown',
      costResult.actualCost,
      payment?.asset || 'USDC',
      responseTime,
    );

    // Add x402 receipt header
    if (payment) {
      res.setHeader(
        'X-Payment-Receipt',
        JSON.stringify({
          id: payment.id,
          quoteId: payment.quoteId,
          txHash: payment.txHash,
          payerAddress: payment.payerAddress,
          amount: payment.amount?.toString(),
          asset: payment.asset,
          status: payment.status,
          actualCost: costResult.actualCost,
          tokensUsed: tokensUsed ?? null,
        }),
      );
    }
    res.setHeader('X-Request-Trace-Id', traceId);

    await this.adminService.writeAuditLog({
      action: 'request_forwarded',
      entity: 'request',
      entityId: traceId,
      providerId: route.providerId,
      actor: payment?.payerAddress || 'unknown',
      details: {
        model: body.model,
        route: route.path,
        txHash,
        responseTime,
        upstreamUrl,
        tokens: tokensUsed,
        actualCost: costResult.actualCost,
        surplus: costResult.surplus,
        traceId,
      },
    });

    return res.json(response);
  }

  // ── Per-Token Metered Pricing ──────────────

  /**
   * Apply per-token metered pricing after receiving the LLM response.
   *
   * For flat-rate routes: simply returns the paid amount as the actual cost.
   * For per-token routes:
   *   1. Calculates actual cost from tokens used × perTokenPrice
   *   2. Compares against the paid amount
   *   3. Sets X-Actual-Cost, X-Tokens-Used headers
   *   4. Records the actual cost on the payment
   *   5. Returns the cost details for analytics
   */
  private async applyMeteredPricing(
    route: RouteConfig,
    payment: PaymentRecord | null,
    tokensUsed: number | undefined,
    res: Response,
    traceId: string,
  ): Promise<{
    actualCost: string;
    surplus: string;
    isOverpaid: boolean;
    isUnderpaid: boolean;
  }> {
    if (route.pricingModel !== 'per_token' || !tokensUsed) {
      // Flat-rate or no token data: actual cost = paid amount
      const paid = payment?.amount?.toString() || '0';
      if (!res.headersSent) {
        res.setHeader('X-Actual-Cost', paid);
      }
      return {
        actualCost: paid,
        surplus: '0',
        isOverpaid: false,
        isUnderpaid: false,
      };
    }

    // Calculate actual per-token cost
    const priceResult = calculatePrice({ route, tokenCount: tokensUsed });
    const actualCost = priceResult.amount;

    // Compare against paid amount
    const paidAmount = payment?.amount?.toString() || actualCost;
    const comparison = comparePayment(paidAmount, actualCost);

    // Set response headers (skip if streaming — headers already flushed)
    if (!res.headersSent) {
      res.setHeader('X-Actual-Cost', actualCost);
      res.setHeader('X-Tokens-Used', String(tokensUsed));
      res.setHeader('X-Paid-Amount', paidAmount);
      if (comparison.surplus !== '0') {
        res.setHeader('X-Surplus', comparison.surplus);
      }
    }

    // Record actual cost on the payment
    if (payment) {
      await this.paymentsService.recordActualCost(payment.quoteId, actualCost, tokensUsed);
    }

    logger.info('Per-token cost calculated', {
      traceId,
      tokensUsed,
      actualCost,
      paidAmount,
      surplus: comparison.surplus,
      isOverpaid: comparison.isOverpaid,
      isUnderpaid: comparison.isUnderpaid,
    });

    if (comparison.isUnderpaid) {
      logger.warn('Per-token underpayment detected', {
        traceId,
        tokensUsed,
        actualCost,
        paidAmount,
        shortfall: comparison.surplus,
      });
    }

    return {
      actualCost,
      surplus: comparison.surplus,
      isOverpaid: comparison.isOverpaid,
      isUnderpaid: comparison.isUnderpaid,
    };
  }
}
