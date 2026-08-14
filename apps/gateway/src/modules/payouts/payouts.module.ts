import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PayoutsService } from './payouts.service';
import { DatabaseModule } from '@x402/database';

@Module({
  imports: [ScheduleModule.forRoot(), DatabaseModule],
  providers: [PayoutsService],
  exports: [PayoutsService],
})
export class PayoutsModule {}
