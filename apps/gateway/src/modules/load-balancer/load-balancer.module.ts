import { Module } from '@nestjs/common';
import { LoadBalancerService } from './load-balancer.service';

@Module({
  providers: [LoadBalancerService],
  exports: [LoadBalancerService],
})
export class LoadBalancerModule {}