import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { X402Module } from '../x402/x402.module';
import { RoutesModule } from '../routes/routes.module';
import { ProvidersModule } from '../providers/providers.module';
import { PaymentsModule } from '../payments/payments.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AdminModule } from '../admin/admin.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { LoadBalancerModule } from '../load-balancer/load-balancer.module';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';

@Module({
  imports: [
    X402Module,
    RoutesModule,
    ProvidersModule,
    PaymentsModule,
    AnalyticsModule,
    AdminModule,
    WebhooksModule,
    LoadBalancerModule,
  ],
  controllers: [ProxyController],
  providers: [ProxyService, RateLimitGuard],
})
export class ProxyModule {}
