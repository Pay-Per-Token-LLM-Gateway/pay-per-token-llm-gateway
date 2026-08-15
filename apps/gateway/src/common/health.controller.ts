import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { getConfig } from '@x402/config';

/**
 * Health check endpoint for load balancers, monitoring, and deployment verification.
 *
 * Excluded from the global `api/v1` prefix so load balancers can hit `/health` directly.
 * Returns 200 with basic service info when the gateway is healthy.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Liveness probe — is the process up?' })
  check() {
    const config = getConfig();
    return {
      status: 'ok',
      service: 'x402-gateway',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.nodeEnv,
      network: config.stellar.network,
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — can the gateway serve traffic?' })
  ready() {
    // Liveness passed; the gateway can serve requests once the event loop is
    // responsive. Deep dependency checks (Prisma/Redis) are intentionally light
    // so the probe stays fast and does not flap during transient degradations.
    const config = getConfig();
    return {
      status: 'ready',
      service: 'x402-gateway',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.nodeEnv,
      network: config.stellar.network,
    };
  }
}
