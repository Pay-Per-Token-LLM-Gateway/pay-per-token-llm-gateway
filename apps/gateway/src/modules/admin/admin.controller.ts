import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { AuthGuard } from '../auth/auth.guard';

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check' })
  async health() {
    return this.adminService.getHealth();
  }

  @Get('stats')
  @ApiOperation({ summary: 'Gateway statistics' })
  async stats() {
    return this.adminService.getStats();
  }

  @Get('audit')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get audit logs' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'entity', required: false })
  async auditLogs(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('action') action?: string,
    @Query('entity') entity?: string,
  ) {
    return this.adminService.getAuditLogs({ page, limit, action, entity });
  }

  @Get('load-balancer/health')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get load balancer provider health status' })
  async loadBalancerHealth() {
    return this.adminService.getLoadBalancerHealth();
  }
}
