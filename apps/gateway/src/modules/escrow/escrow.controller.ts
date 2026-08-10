import { Controller, Get, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CreditEscrowService } from './credit-escrow.service';

type AuthenticatedRequest = Request & { authenticatedAddress?: string };

@ApiTags('escrow')
@Controller('escrow')
@UseGuards(AuthGuard)
export class EscrowController {
  constructor(private readonly escrowService: CreditEscrowService) {}

  @Get('balances')
  @ApiOperation({ summary: 'Read the authenticated wallet credit balance' })
  async getBalance(@Req() req: AuthenticatedRequest) {
    const address = this.requireAddress(req);
    return {
      address,
      configured: this.escrowService.isConfigured(),
      balance: (await this.escrowService.readBalance(address)).toString(),
    };
  }

  @Get('usage')
  @ApiOperation({ summary: 'Read the authenticated wallet escrow usage history' })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getUsage(
    @Req() req: AuthenticatedRequest,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    const address = this.requireAddress(req);
    return {
      address,
      usage: await this.escrowService.readUsage(
        address,
        offset ? Number(offset) : 0,
        limit ? Number(limit) : 50,
      ),
    };
  }

  private requireAddress(req: AuthenticatedRequest): string {
    if (!req.authenticatedAddress) {
      throw new UnauthorizedException('Authenticated wallet address is missing');
    }
    return req.authenticatedAddress;
  }
}
