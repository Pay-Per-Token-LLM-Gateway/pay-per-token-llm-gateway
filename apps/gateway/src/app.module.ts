import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { X402Module } from './modules/x402/x402.module';
import { ProxyModule } from './modules/proxy/proxy.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { RoutesModule } from './modules/routes/routes.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthController } from './common/health.controller';
import { PrismaModule } from './common/prisma.module';
import { RedisModule } from './common/redis.module';
import { EscrowModule } from './modules/escrow/escrow.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    X402Module,
    ProxyModule,
    ProvidersModule,
    RoutesModule,
    PaymentsModule,
    AnalyticsModule,
    WebhooksModule,
    AdminModule,
    AuthModule,
    EscrowModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
