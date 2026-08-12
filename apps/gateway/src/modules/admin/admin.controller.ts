import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentWallet } from '../auth/current-wallet.decorator';
import { paginationSchema } from '@x402/validation';

@ApiTags('admin')
@Controller('admin')
@UseGuards(AuthGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Gateway statistics scoped to the authenticated wallet' })
  async stats(@CurrentWallet() wallet: string) {
    return this.adminService.getStats(wallet);
  }

  @Get('audit')
  @ApiOperation({ summary: "Get audit logs for the authenticated wallet's providers" })
  @ApiQuery({ name: 'providerId', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'entity', required: false })
  async auditLogs(
    @CurrentWallet() wallet: string,
    @Query('providerId') providerId?: string,
    // Express query params always arrive as strings; paginationSchema coerces
    // them to numbers (and rejects NaN/negative via z.coerce + positive int).
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('entity') entity?: string,
  ) {
    // Validate/clamp pagination — raw query strings (e.g. page=abc, limit=-1)
    // previously reached Prisma as NaN/negative skip/take and 500'd.
    const parsed = paginationSchema.safeParse({
      page: page === '' || page === undefined ? undefined : page,
      limit: limit === '' || limit === undefined ? undefined : limit,
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const { page: safePage, limit: safeLimit } = parsed.data;
    return this.adminService.getAuditLogs(wallet, {
      providerId,
      page: safePage,
      limit: safeLimit,
      action,
      entity,
    });
  }
}
