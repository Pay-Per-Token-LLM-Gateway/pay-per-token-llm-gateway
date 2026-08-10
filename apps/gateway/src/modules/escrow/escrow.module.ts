import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CreditEscrowService } from './credit-escrow.service';
import { EscrowController } from './escrow.controller';

@Module({
  imports: [AuthModule],
  controllers: [EscrowController],
  providers: [CreditEscrowService],
  exports: [CreditEscrowService],
})
export class EscrowModule {}
