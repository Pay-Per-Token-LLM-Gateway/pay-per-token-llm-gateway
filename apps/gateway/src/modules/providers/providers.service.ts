import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { prisma } from '@x402/database';
import { logger } from '@x402/logger';
import { StrKey } from '@stellar/stellar-sdk';
import { validateWebhookUrl } from '../webhooks/webhooks.service';
import { getConfig } from '@x402/config';
import type { Provider } from '@x402/types';

/**
 * Map a raw Prisma provider row to the typed Provider response.
 */
function toProviderResponse(p: {
  id: string;
  name: string;
  walletAddress: string;
  payoutWalletAddress: string | null;
  webhookUrl: string | null;
  active: boolean;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): Provider {
  return {
    id: p.id,
    name: p.name,
    walletAddress: p.walletAddress,
    payoutWalletAddress: p.payoutWalletAddress || undefined,
    webhookUrl: p.webhookUrl || undefined,
    active: p.active,
    metadata: p.metadata as Record<string, string> | undefined,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

@Injectable()
export class ProvidersService {
  /**
   * List providers owned by the authenticated wallet.
   * A provider's ownership is its `walletAddress` — the wallet that receives
   * its payments — so only providers whose wallet matches the caller are
   * returned.
   */
  async findAll(ownerAddress: string): Promise<Provider[]> {
    const providers = await prisma.provider.findMany({
      where: { walletAddress: ownerAddress },
      include: { routes: true },
    });

    return providers.map(toProviderResponse);
  }

  async findById(id: string, ownerAddress: string): Promise<Provider> {
    const p = await prisma.provider.findFirst({
      where: { id, walletAddress: ownerAddress },
      include: { routes: true },
    });

    if (!p) throw new NotFoundException(`Provider ${id} not found`);

    return toProviderResponse(p);
  }

  /**
   * Create a provider. The provider is always owned by the authenticated
   * wallet — the walletAddress is taken from the caller, never from the
   * request body (prevents claiming a provider that pays out to another
   * wallet).
   */
  async create(
    data: {
      name: string;
      payoutWalletAddress?: string;
      webhookUrl?: string;
      webhookSecret?: string;
      metadata?: Record<string, string>;
    },
    ownerAddress: string,
  ): Promise<Provider> {
    this.validatePayoutWallet(data.payoutWalletAddress, ownerAddress);

    const config = getConfig();
    const isActive = config.security.providerApprovalRequired ? false : true;

    const p = await prisma.provider.create({
      data: {
        name: data.name,
        walletAddress: ownerAddress,
        payoutWalletAddress: data.payoutWalletAddress,
        webhookUrl: await this.normalizeWebhookUrl(data.webhookUrl, false),
        webhookSecret: data.webhookSecret || null,
        metadata: data.metadata || {},
        active: isActive,
      },
    });

    logger.info('Provider created', { providerId: p.id, name: p.name, active: p.active });

    return toProviderResponse(p);
  }

  async update(
    id: string,
    data: Partial<Pick<Provider, 'name' | 'active' | 'webhookUrl' | 'webhookSecret'>> & { payoutWalletAddress?: string },
    ownerAddress: string,
  ): Promise<Provider> {
    // Ownership check first — only the wallet that owns this provider may edit it.
    const existing = await prisma.provider.findFirst({
      where: { id, walletAddress: ownerAddress },
    });
    if (!existing) throw new NotFoundException(`Provider ${id} not found`);

    const updateData: Record<string, unknown> = {};

    if (data.name !== undefined) updateData.name = data.name;
    if (data.active !== undefined) updateData.active = data.active;
    if (data.payoutWalletAddress !== undefined) {
      this.validatePayoutWallet(data.payoutWalletAddress, ownerAddress);
      updateData.payoutWalletAddress = data.payoutWalletAddress;
    }
    if (data.webhookUrl !== undefined) {
      updateData.webhookUrl = await this.normalizeWebhookUrl(data.webhookUrl, true);
    }
    if (data.webhookSecret !== undefined) {
      updateData.webhookSecret = data.webhookSecret;
    }

    const p = await prisma.provider.update({
      where: { id },
      data: updateData,
    });

    return toProviderResponse(p);
  }

  /**
   * Validate a payout wallet address:
   * - Must be a valid Stellar public key (Ed25519) when set
   * - Must differ from the auth wallet (unless opted out via config)
   */
  private validatePayoutWallet(
    payoutWalletAddress: string | undefined,
    ownerAddress: string,
  ): void {
    if (!payoutWalletAddress) return;

    if (!StrKey.isValidEd25519PublicKey(payoutWalletAddress)) {
      throw new BadRequestException(
        `Invalid payout wallet address: "${payoutWalletAddress}" is not a valid Stellar public key`,
      );
    }

    const config = getConfig();
    if (!config.security.allowPayoutEqualsAuthWallet && payoutWalletAddress === ownerAddress) {
      throw new BadRequestException(
        'Payout wallet must differ from the authenticated wallet. Use a separate wallet for receiving payouts.',
      );
    }
  }

  /**
   * Approve a provider (sets active=true). Only callable by an admin.
   * Requires PROVIDER_APPROVAL_REQUIRED=true to be meaningful.
   */
  async approve(id: string): Promise<Provider> {
    const p = await prisma.provider.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(`Provider ${id} not found`);

    const updated = await prisma.provider.update({
      where: { id },
      data: { active: true },
    });

    logger.info('Provider approved', { providerId: id });
    return toProviderResponse(updated);
  }

  /**
   * Validate and normalize a provider webhook URL before persisting.
   *
   * Applies the SSRF guard (HTTPS + public IP, DNS-resolved) at save time so
   * a configured webhook can never point at internal infrastructure. An
   * empty string means "no webhook" (used by clients to clear the value).
   */
  private async normalizeWebhookUrl(
    raw: string | undefined,
    allowUndefined: boolean,
  ): Promise<string | null | undefined> {
    if (raw === undefined) return allowUndefined ? undefined : null;
    if (raw === '') return null; // explicit clear / not configured
    try {
      return await validateWebhookUrl(raw);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  async delete(id: string, ownerAddress: string): Promise<void> {
    // Ownership-scoped delete: only deletes if the wallet owns this provider.
    const result = await prisma.provider.deleteMany({
      where: { id, walletAddress: ownerAddress },
    });
    if (result.count === 0) {
      throw new NotFoundException(`Provider ${id} not found`);
    }
    logger.info('Provider deleted', { providerId: id });
  }

  async findByWalletAddress(address: string): Promise<Provider | null> {
    const p = await prisma.provider.findFirst({ where: { walletAddress: address } });
    if (!p) return null;
    return toProviderResponse(p);
  }
}