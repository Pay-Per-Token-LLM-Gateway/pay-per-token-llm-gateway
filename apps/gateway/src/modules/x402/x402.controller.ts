import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { X402Service } from './x402.service';
import { RoutesService } from '../routes/routes.service';
import { PaymentsService } from '../payments/payments.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { verifyPaymentSchema } from '@x402/validation';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import type { Quote } from '@x402/types';

@ApiTags('x402')
@Controller('x402')
// Public verification endpoint — rate-limit it so a caller can't spam
// Redis writes + Horizon lookups (quote-spam / resource exhaustion).
@UseGuards(RateLimitGuard)
export class X402Controller {
  constructor(
    private readonly x402Service: X402Service,
    private readonly routesService: RoutesService,
    private readonly paymentsService: PaymentsService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  /**
   * Verify a payment for a specific quote.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyPayment(
    @Body() body: { txHash?: string; escrowPayerAddress?: string; quoteId: string },
  ) {
    const parsed = verifyPaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.errors);
    }

    const { txHash, escrowPayerAddress, quoteId } = parsed.data;

    // Look up the quote from cache/payment store
    const storedPayment = await this.paymentsService.findByQuoteId(quoteId);
    if (!storedPayment) {
      throw new BadRequestException('Quote not found or expired');
    }

    // Single-use invariant: only pending quotes may be verified. Re-verifying
    // an already-confirmed quote would let a caller overwrite its txHash and
    // orphan the previously consumed hash, weakening replay protection.
    if (storedPayment.status !== 'pending') {
      throw new BadRequestException('Quote already processed');
    }

    const quote = storedPayment.receiptJson as Quote;

    let verification;
    if (escrowPayerAddress) {
      verification = await this.x402Service.verifyEscrowPayment(escrowPayerAddress, quote);
    } else if (txHash) {
      verification = await this.x402Service.verifyPayment(txHash, quote);
    } else {
      throw new BadRequestException('txHash or escrowPayerAddress is required');
    }

    if (verification.verified) {
      const receipt = await this.paymentsService.confirmPayment(quoteId, verification);
      if (!receipt) {
        // A concurrent request claimed this hash first — single-use holds.
        return {
          verified: false,
          txHash: verification.txHash,
          payerAddress: '',
          amount: '0',
          asset: quote.asset,
          ledger: 0,
          timestamp: 0,
          failureReason: 'Payment already used (replay protection)',
        };
      }
    }

    return verification;
  }

  /**
   * Get payment status for a quote.
   */
  @Get('status/:quoteId')
  @ApiOperation({ summary: 'Get payment status for a quote' })
  @ApiParam({ name: 'quoteId', type: 'string' })
  async getPaymentStatus(@Param('quoteId') quoteId: string) {
    const payment = await this.paymentsService.findByQuoteId(quoteId);
    if (!payment) {
      throw new BadRequestException('Quote not found');
    }

    return {
      quoteId,
      status: payment.status,
      txHash: payment.txHash,
      verifiedAt: payment.verifiedAt,
    };
  }
}
