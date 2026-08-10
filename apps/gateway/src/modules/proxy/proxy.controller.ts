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
import { chatCompletionRequestSchema } from '@x402/validation';
import { calculatePrice, comparePayment } from '@x402/x402-core';
import { logger } from '@x402/logger';
import { generateId } from '@x402/shared';
import type { ChatCompletionRequest, PaymentRecord, Quote, RouteConfig } from '@x402/types';
import { AuthService } from '../auth/auth.service';
import { CreditEscrowService } from '../escrow/credit-escrow.service';

interface EscrowContext {
  userAddress: string;
  quoteId: string;
  estimatedAmount: string;
}

type AuthenticatedRequest = Request & { authenticatedAddress?: string };

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
    private readonly authService: AuthService,
    private readonly escrowService: CreditEscrowService,
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

      // 2. Look up route — strip global prefix from req.path for matching
      const routePath = req.path.replace(/^\/api\/v1/, '') || req.path;
      const route = await this.routesService.findByPathAndModel(routePath, model);
      if (!route) {
        return res.status(404).json({
          status: 404,
          error: 'Not Found',
          message: `No route configured for model: ${model}`,
        });
      }

      // 3. Use authenticated credit escrow when available. Requests without
      // a valid session keep the original x402 payment flow unchanged.
      const txHash = req.headers['x-payment-hash'] as string | undefined;
      if (!txHash) {
        const escrow = await this.tryEscrow(req as AuthenticatedRequest, route, body);
        if (escrow) {
          const upstreamApiKey =
            process.env[`UPSTREAM_API_KEY_${route.providerId.toUpperCase().replace(/-/g, '_')}`];

          if (body.stream) {
            return this.handleStreamingForward(
              res,
              body,
              route,
              'escrow',
              upstreamApiKey,
              null,
              traceId,
              startTime,
              escrow,
            );
          }

          return this.handleNonStreamingForward(
            res,
            body,
            route,
            'escrow',
            upstreamApiKey,
            null,
            traceId,
            startTime,
            escrow,
          );
        }
      }

      // 4. Check for payment header
      if (!txHash) {
        return this.handle402Response(res, route, traceId, model, body);
      }

      // 5. Verify payment (includes cross-route replay protection)
      const verified = await this.verifyAndConfirmPayment(txHash, route, res, traceId);
      if (!verified) {
        return; // 402 error response already sent
      }

      // 6. Resolve upstream API key
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

  private async tryEscrow(
    req: AuthenticatedRequest,
    route: RouteConfig,
    body: ChatCompletionRequest,
  ): Promise<EscrowContext | null> {
    const userAddress = await this.resolveAuthenticatedAddress(req);
    if (!userAddress || !this.escrowService.isConfigured()) return null;

    try {
      const quote = await this.x402Service.generateQuoteForRoute(route, body.max_tokens);
      // The deployed credit-escrow contract is configured for the same
      // smallest-unit accounting used by the gateway's USDC routes.
      if (quote.asset !== 'USDC') return null;
      const check = await this.escrowService.checkEscrow(userAddress, BigInt(quote.amount));
      if (!check.useEscrow) return null;

      logger.info('Using credit escrow for request', {
        userAddress,
        route: route.path,
        estimatedAmount: quote.amount,
      });
      return { userAddress, quoteId: quote.id, estimatedAmount: quote.amount };
    } catch (error) {
      logger.warn('Credit escrow unavailable; continuing with x402 payment flow', {
        error: String(error),
      });
      return null;
    }
  }

  private async resolveAuthenticatedAddress(
    req: AuthenticatedRequest,
  ): Promise<string | undefined> {
    const header = req.headers.authorization;
    if (!header) return undefined;
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return undefined;

    try {
      const result = await this.authService.validateToken(token);
      return result.valid ? result.address : undefined;
    } catch (error) {
      logger.warn('Optional escrow authentication failed; continuing with x402', {
        error: String(error),
      });
      return undefined;
    }
  }

  private async chargeEscrow(
    escrow: EscrowContext,
    actualCost: string,
    traceId: string,
  ): Promise<void> {
    const charge = await this.escrowService.charge(
      escrow.userAddress,
      BigInt(actualCost),
      escrow.quoteId,
    );
    logger.info('Credit escrow charged', {
      traceId,
      userAddress: escrow.userAddress,
      txHash: charge.txHash,
      amount: charge.charged.toString(),
      remaining: charge.remaining.toString(),
    });
  }

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

      logger.info('Payment already confirmed for this route', {
        traceId,
        txHash,
      });
      return true;
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

    if (existingPayment) {
      await this.paymentsService.confirmPayment(existingPayment.quoteId, verification);
    } else {
      await this.paymentsService.createPendingPayment(quoteForVerification, route);
      await this.paymentsService.confirmPayment(quoteForVerification.id, verification);
    }

    await this.adminService.writeAuditLog({
      action: 'payment_verified',
      entity: 'payment',
      entityId: txHash,
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
    escrow?: EscrowContext,
  ) {
    logger.info('Forwarding streaming request to upstream', {
      traceId,
      model: body.model,
      upstreamUrl: route.upstreamUrl,
      pricingModel: route.pricingModel,
    });

    res.setHeader('X-Request-Trace-Id', traceId);

    // Pipe upstream SSE stream to client; extract tokens for per-token pricing
    await this.proxyService.forwardStreamRequest(
      body,
      route.upstreamUrl,
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
          escrow?.estimatedAmount,
        );

        if (escrow) {
          await this.chargeEscrow(escrow, costResult.actualCost, traceId);
        }

        await this.analyticsService.recordPaidRequest(
          route.path,
          route.providerId,
          escrow?.userAddress || payment?.payerAddress || 'unknown',
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
      actor: escrow?.userAddress || payment?.payerAddress || 'unknown',
      details: { model: body.model, route: route.path, txHash, traceId },
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
    escrow?: EscrowContext,
  ) {
    logger.info('Forwarding request to upstream', {
      traceId,
      model: body.model,
      upstreamUrl: route.upstreamUrl,
      pricingModel: route.pricingModel,
    });

    const { response, responseTime } = await this.proxyService.forwardRequest(
      body,
      route.upstreamUrl,
      apiKey,
      traceId,
    );

    // Calculate actual cost for per-token pricing
    const tokensUsed = response.usage?.total_tokens;
    const costResult = await this.applyMeteredPricing(
      route,
      payment,
      tokensUsed,
      res,
      traceId,
      escrow?.estimatedAmount,
    );

    if (escrow) {
      await this.chargeEscrow(escrow, costResult.actualCost, traceId);
      res.setHeader('X-Escrow-Charge', escrow.quoteId);
    }

    await this.analyticsService.recordPaidRequest(
      route.path,
      route.providerId,
      escrow?.userAddress || payment?.payerAddress || 'unknown',
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
      actor: escrow?.userAddress || payment?.payerAddress || 'unknown',
      details: {
        model: body.model,
        route: route.path,
        txHash,
        responseTime,
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
    escrowEstimate?: string,
  ): Promise<{
    actualCost: string;
    surplus: string;
    isOverpaid: boolean;
    isUnderpaid: boolean;
  }> {
    if (route.pricingModel !== 'per_token' || !tokensUsed) {
      // Flat-rate or no token data: actual cost = paid amount
      const paid = payment?.amount?.toString() || escrowEstimate || '0';
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
    const paidAmount = payment?.amount?.toString() || escrowEstimate || actualCost;
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
