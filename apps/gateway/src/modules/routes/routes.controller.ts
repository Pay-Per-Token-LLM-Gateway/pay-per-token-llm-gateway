import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { RoutesService } from './routes.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentWallet } from '../auth/current-wallet.decorator';
import { routeConfigSchema, routeUpdateSchema } from '@x402/validation';
import type { PaymentAsset } from '@x402/types';

@ApiTags('routes')
@Controller('routes')
@UseGuards(AuthGuard)
export class RoutesController {
  constructor(private readonly routesService: RoutesService) {}

  @Get()
  @ApiOperation({ summary: 'List routes owned by the authenticated wallet' })
  @ApiQuery({ name: 'providerId', required: false })
  async findAll(@CurrentWallet() wallet: string, @Query('providerId') providerId?: string) {
    return this.routesService.findAll(wallet, providerId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get route by ID (must belong to the caller)' })
  async findById(@Param('id') id: string, @CurrentWallet() wallet: string) {
    return this.routesService.findById(id, wallet);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new protected route (provider must be owned by the caller)' })
  async create(
    @Body()
    body: {
      providerId: string;
      path: string;
      upstreams: { url: string; weight?: number; active?: boolean }[];
      model: string;
      pricingModel: 'flat' | 'per_token';
      flatPrice?: string;
      perTokenPrice?: string;
      acceptedAssets?: PaymentAsset[];
      rateLimit?: number;
    },
    @CurrentWallet() wallet: string,
  ) {
    const parsed = routeConfigSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.routesService.create(parsed.data, wallet);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a route (must belong to the caller)' })
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      upstreams?: { url: string; weight?: number; active?: boolean }[];
      flatPrice?: string;
      perTokenPrice?: string;
      pricingModel?: 'flat' | 'per_token';
      rateLimit?: number;
      active?: boolean;
    },
    @CurrentWallet() wallet: string,
  ) {
    const parsed = routeUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.routesService.update(id, parsed.data, wallet);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a route (must belong to the caller)' })
  async delete(@Param('id') id: string, @CurrentWallet() wallet: string) {
    await this.routesService.delete(id, wallet);
  }
}
