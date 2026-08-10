import { Global, Module } from '@nestjs/common';
import { LoadBalancerService } from './load-balancer.service';

@Global()
@Module({
  providers: [LoadBalancerService],
  exports: [LoadBalancerService],
})
export class LoadBalancerModule {}
