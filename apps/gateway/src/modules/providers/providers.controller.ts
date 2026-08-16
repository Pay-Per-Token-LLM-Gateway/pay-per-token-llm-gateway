import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ProvidersService } from './providers.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentWallet } from '../auth/current-wallet.decorator';
import { providerCreateSchema, providerUpdateSchema } from '@x402/validation';

@ApiTags('providers')
@Controller('providers')
@UseGuards(AuthGuard)
export class ProvidersController {
  constructor(private readonly providersService: ProvidersService) {}

  @Get()
  @ApiOperation({ summary: 'List providers owned by the authenticated wallet' })
  async findAll(@CurrentWallet() wallet: string) {
    return this.providersService.findAll(wallet);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get provider by ID (must be owned by the caller)' })
  async findById(@Param('id') id: string, @CurrentWallet() wallet: string) {
    return this.providersService.findById(id, wallet);
  }

  @Post()
  @ApiOperation({ summary: 'Register a new provider (owned by the authenticated wallet)' })
  async create(
    @Body()
    body: {
      name: string;
      payoutWalletAddress?: string;
      webhookUrl?: string;
      webhookSecret?: string;
    },
    @CurrentWallet() wallet: string,
  ) {
    const parsed = providerCreateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.providersService.create(parsed.data, wallet);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update provider (must be owned by the caller)' })
  async update(
    @Param('id') id: string,
    @Body() body: { name?: string; active?: boolean; webhookUrl?: string; webhookSecret?: string; payoutWalletAddress?: string },
    @CurrentWallet() wallet: string,
  ) {
    const parsed = providerUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.providersService.update(id, parsed.data, wallet);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a provider (sets active=true). Requires PROVIDER_APPROVAL_REQUIRED=true.' })
  async approve(@Param('id') id: string) {
    return this.providersService.approve(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete provider (must be owned by the caller)' })
  async delete(@Param('id') id: string, @CurrentWallet() wallet: string) {
    await this.providersService.delete(id, wallet);
  }
}