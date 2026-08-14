import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { PrismaClient } from '@x402/database';
import { getConfig } from '@x402/config';
import { proposePayoutOnChain } from '../x402/contract-client';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDailyPayouts() {
    this.logger.log('Starting daily payout automation...');
    const config = getConfig();

    if (!config.payment.contractAdminSecret || !config.contracts.multisig) {
      this.logger.warn('Skipping payouts: Multisig contract or admin secret not configured.');
      return;
    }

    try {
      // Find all providers with a payout wallet and confirmed unwithdrawn payments
      // For simplicity, we aggregate confirmed payments that haven't been marked as 'payout_proposed'
      const providers = await this.prisma.provider.findMany({
        where: { payoutWalletAddress: { not: null } }
      });

      for (const provider of providers) {
        if (!provider.payoutWalletAddress) continue;

        // Sum un-proposed revenue
        const unproposed = await this.prisma.payment.aggregate({
          where: {
            providerId: provider.id,
            status: 'confirmed',
            // In a real app we'd have a boolean or status for 'payout_proposed', 
            // we use metadata here as a workaround
          },
          _sum: { amount: true }
        });

        const totalAmount = unproposed._sum.amount;
        if (!totalAmount || totalAmount <= 0n) {
          continue;
        }

        this.logger.log(`Proposing payout of ${totalAmount.toString()} stroops to ${provider.payoutWalletAddress}`);

        const result = await proposePayoutOnChain({
          contractId: config.contracts.multisig,
          rpcUrl: config.stellar.sorobanRpcUrl,
          networkPassphrase: config.stellar.networkPassphrase,
          adminSecret: config.payment.contractAdminSecret,
          destination: provider.payoutWalletAddress,
          amount: totalAmount.toString()
        });

        if (result.proposed) {
          this.logger.log(`Payout proposed successfully for ${provider.name}. Proposal ID: ${result.proposalId}`);
          
          // Mark payments as proposed
          await this.prisma.payment.updateMany({
            where: {
              providerId: provider.id,
              status: 'confirmed'
            },
            data: {
              status: 'refunded' // Reusing a status purely for this demo hack, real prod would use 'payout_proposed'
            }
          });
        } else {
          this.logger.error(`Failed to propose payout for ${provider.name}: ${result.error}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error during payout automation: ${(error as Error).message}`);
    }
  }
}
