import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { prisma } from '@x402/database';
import { logger } from '@x402/logger';
import { proposePayout, approvePayout, getMultisigConfig } from '../x402/multisig-client';

@Injectable()
export class AdminService {
  async getHealth() {
    return {
      status: 'ok' as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '0.1.0',
    };
  }

  /**
   * Gateway statistics scoped to the authenticated wallet's providers.
   * Unscoped global counts were a cross-tenant information leak.
   */
  async getStats(ownerAddress: string) {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    const [providers, routes, payments, confirmedPayments] = await Promise.all([
      prisma.provider.count({ where: { walletAddress: ownerAddress } }),
      prisma.route.count({ where: { providerId: { in: providerIds } } }),
      prisma.payment.count({ where: { providerId: { in: providerIds } } }),
      prisma.payment.count({
        where: { providerId: { in: providerIds }, status: 'confirmed' },
      }),
    ]);

    return {
      providers,
      routes,
      totalPayments: payments,
      confirmedPayments,
      failedPayments: payments - confirmedPayments,
    };
  }

  /**
   * Resolve the provider IDs owned by the authenticated wallet. All audit
   * reads are scoped to this set — a wallet can never see another wallet's
   * audit entries.
   */
  private async getOwnedProviderIds(ownerAddress: string): Promise<string[]> {
    const providers = await prisma.provider.findMany({
      where: { walletAddress: ownerAddress },
      select: { id: true },
    });
    return providers.map((p: { id: string }) => p.id);
  }

  /**
   * Get audit logs belonging to the authenticated wallet's providers, with
   * pagination and filtering. Log entries are never leaked across wallets.
   */
  async getAuditLogs(
    ownerAddress: string,
    options: {
      page?: number;
      limit?: number;
      action?: string;
      entity?: string;
      providerId?: string;
    } = {},
  ): Promise<{
    data: Array<Record<string, unknown>>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = options.page || 1;
    const limit = options.limit || 50;
    const { action, entity } = options;

    // Ownership gate first — never construct a query for a resource the
    // caller cannot touch (404 instead of 403 so provider IDs can't be probed).
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    if (options.providerId && !providerIds.includes(options.providerId)) {
      throw new NotFoundException(`Provider ${options.providerId} not found`);
    }
    const where: Record<string, unknown> = options.providerId
      ? { providerId: options.providerId }
      : { providerId: { in: providerIds } };
    if (action) where.action = action;
    if (entity) where.entity = entity;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return { data: logs, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async writeAuditLog(data: {
    action: string;
    entity: string;
    entityId?: string;
    /** Provider the audit entry belongs to — used to scope reads to owners. */
    providerId?: string;
    actor?: string;
    details?: Record<string, unknown>;
    ip?: string;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.auditLog.create({ data: data as any });
  }

  /**
   * Expire pending payments whose quote window has passed. Called by the
   * hourly cleanup job — prevents unbounded accumulation of stale rows.
   * Returns the number of payments expired.
   */
  async expireStalePayments(quoteExpirySeconds: number): Promise<number> {
    const cutoff = new Date(Date.now() - quoteExpirySeconds * 1000);
    const result = await prisma.payment.updateMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      data: { status: 'expired' },
    });
    if (result.count > 0) {
      logger.info(`Expired ${result.count} stale pending payments`, { cutoff });
    }
    return result.count;
  }

  // ── Payout Automation ────────────────────────

  /**
   * Propose a payout to a provider's wallet via the multisig contract.
   * When threshold = 1, the payout is executed immediately on-chain.
   */
  async proposePayout(
    providerId: string,
    ownerAddress: string,
  ): Promise<Record<string, unknown>> {
    const config = getConfig();
    if (!config.payment.payoutAutomationEnabled) {
      throw new BadRequestException('Payout automation is not enabled');
    }
    if (!config.payment.contractAdminSecret) {
      throw new BadRequestException('CONTRACT_ADMIN_SECRET is required for payouts');
    }

    // Ownership gate: only the provider owner can propose payouts
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    if (!providerIds.includes(providerId)) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    const provider = await prisma.provider.findUnique({
      where: { id: providerId },
      select: { id: true, payoutWalletAddress: true },
    });
    if (!provider) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }
    if (!provider.payoutWalletAddress) {
      throw new BadRequestException('Provider has no payout wallet address configured');
    }

    // Calculate confirmed revenue for this provider.
    const revenue = await prisma.payment.aggregate({
      where: { providerId, status: 'confirmed' },
      _sum: { amount: true },
    });
    const totalRevenue = revenue._sum.amount || BigInt(0);
    if (totalRevenue <= 0n) {
      throw new BadRequestException('No confirmed revenue to pay out');
    }

    // Fetch multisig config to determine threshold
    const multisigConfig = await getMultisigConfig(
      config.contracts.multisig,
      config.stellar.sorobanRpcUrl,
      config.stellar.networkPassphrase,
    );
    const threshold = multisigConfig?.threshold ?? 1;

    // Propose on-chain via multisig contract
    const onChainResult = await proposePayout({
      contractId: config.contracts.multisig,
      rpcUrl: config.stellar.sorobanRpcUrl,
      networkPassphrase: config.stellar.networkPassphrase,
      adminSecret: config.payment.contractAdminSecret,
      destination: provider.payoutWalletAddress,
      amount: totalRevenue.toString(),
    });

    // Store the proposal in the database
    const proposal = await prisma.payoutProposal.create({
      data: {
        providerId,
        destination: provider.payoutWalletAddress,
        amount: totalRevenue.toString(),
        status: onChainResult.success && threshold <= 1 ? 'approved' : 'pending',
        threshold,
        multisigTxHash: onChainResult.txHash,
      },
    });

    // For threshold = 1, auto-approve on-chain (already done by proposePayout).
    // For higher thresholds, await manual approvals via the dashboard.
    if (onChainResult.success && threshold <= 1) {
      // Mark as executed since the contract auto-executes at threshold 1
      await prisma.payoutProposal.update({
        where: { id: proposal.id },
        data: { status: 'executed', executedAt: new Date() },
      });

      await this.writeAuditLog({
        action: 'payout_executed',
        entity: 'payout_proposal',
        entityId: proposal.id,
        providerId,
        actor: ownerAddress,
        details: { amount: totalRevenue.toString(), destination: provider.payoutWalletAddress },
      });
    }

    await this.writeAuditLog({
      action: 'payout_proposed',
      entity: 'payout_proposal',
      entityId: proposal.id,
      providerId,
      actor: ownerAddress,
      details: { amount: totalRevenue.toString(), onChainProposalId: onChainResult.proposalId },
    });

    return {
      id: proposal.id,
      amount: totalRevenue.toString(),
      destination: provider.payoutWalletAddress,
      threshold,
      status: proposal.status,
    };
  }

  /**
   * Approve a pending payout proposal. For threshold > 1, each signer
   * must approve before the payout is executed.
   */
  async approvePayoutProposal(
    proposalId: string,
    ownerAddress: string,
  ): Promise<Record<string, unknown>> {
    const config = getConfig();
    if (!config.payment.payoutAutomationEnabled) {
      throw new BadRequestException('Payout automation is not enabled');
    }

    const proposal = await prisma.payoutProposal.findUnique({
      where: { id: proposalId },
    });
    if (!proposal) {
      throw new NotFoundException(`Payout proposal ${proposalId} not found`);
    }

    // Ownership gate
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    if (!providerIds.includes(proposal.providerId)) {
      throw new NotFoundException(`Payout proposal ${proposalId} not found`);
    }

    if (proposal.status !== 'pending') {
      throw new BadRequestException(`Proposal is already ${proposal.status}`);
    }

    if (!config.payment.contractAdminSecret) {
      throw new BadRequestException('CONTRACT_ADMIN_SECRET is required');
    }

    // Approve on-chain
    const onChainResult = await approvePayout({
      contractId: config.contracts.multisig,
      rpcUrl: config.stellar.sorobanRpcUrl,
      networkPassphrase: config.stellar.networkPassphrase,
      adminSecret: config.payment.contractAdminSecret,
      proposalId: proposal.multisigTxHash || '0',
      signer: ownerAddress,
    });

    if (!onChainResult.success) {
      throw new BadRequestException('On-chain approval failed');
    }

    // Update the signer approvals list
    await prisma.payoutProposal.update({
      where: { id: proposalId },
      data: {
        signerApprovals: [...proposal.signerApprovals, ownerAddress],
        status: proposal.signerApprovals.length + 1 >= proposal.threshold ? 'executed' : 'approved',
        executedAt: proposal.signerApprovals.length + 1 >= proposal.threshold ? new Date() : undefined,
      },
    });

    await this.writeAuditLog({
      action: 'payout_approved',
      entity: 'payout_proposal',
      entityId: proposalId,
      providerId: proposal.providerId,
      actor: ownerAddress,
    });

    return { id: proposalId, status: 'approved' };
  }

  /**
   * List payout proposals for the authenticated wallet's providers.
   */
  async getPayoutProposals(
    ownerAddress: string,
    options: { page?: number; limit?: number; status?: string } = {},
  ): Promise<{
    data: Array<Record<string, unknown>>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = options.page || 1;
    const limit = options.limit || 50;
    const providerIds = await this.getOwnedProviderIds(ownerAddress);

    const where: Record<string, unknown> = { providerId: { in: providerIds } };
    if (options.status) where.status = options.status;

    const [proposals, total] = await Promise.all([
      prisma.payoutProposal.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payoutProposal.count({ where }),
    ]);

    return { data: proposals, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}
