import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@x402/database';
import { logger } from '@x402/logger';
import type { RouteConfig, PricingModel, PaymentAsset } from '@x402/types';

/**
 * Map a raw Prisma route row to the typed RouteConfig response.
 */
function toRouteConfig(r: {
  id: string;
  providerId: string;
  path: string;
  upstreamUrl: string;
  model: string;
  pricingModel: string;
  flatPrice: string | null;
  perTokenPrice: string | null;
  acceptedAssets: string[];
  rateLimit: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): RouteConfig {
  return {
    id: r.id,
    providerId: r.providerId,
    path: r.path,
    upstreamUrl: r.upstreamUrl,
    model: r.model,
    pricingModel: r.pricingModel as PricingModel,
    flatPrice: r.flatPrice || undefined,
    perTokenPrice: r.perTokenPrice || undefined,
    acceptedAssets: r.acceptedAssets as PaymentAsset[],
    rateLimit: r.rateLimit,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

@Injectable()
export class RoutesService {
  async findAll(providerId?: string): Promise<RouteConfig[]> {
    const routes = await prisma.route.findMany({
      where: providerId ? { providerId } : {},
    });

    return routes.map(toRouteConfig);
  }

  async findByPathAndModel(path: string, model: string): Promise<RouteConfig | null> {
    const r = await prisma.route.findFirst({
      where: { path, model, active: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!r) return null;

    return toRouteConfig(r);
  }

  /**
   * Find all active routes matching the given path and model.
   * Used by the load balancer to select the best upstream when multiple
   * providers offer the same model.
   */
  async findAllByPathAndModel(path: string, model: string): Promise<RouteConfig[]> {
    const routes = await prisma.route.findMany({
      where: { path, model, active: true },
      include: { provider: { select: { active: true } } },
      orderBy: [{ weight: 'desc' }, { createdAt: 'asc' }],
    });

    // Filter out routes whose provider is inactive
    return routes
      .filter((r) => r.provider.active)
      .map(toRouteConfig);
  }

  async findById(id: string): Promise<RouteConfig> {
    const r = await prisma.route.findUnique({ where: { id } });
    if (!r) throw new NotFoundException(`Route ${id} not found`);

    return toRouteConfig(r);
  }

  async create(data: {
    providerId: string;
    path: string;
    upstreamUrl: string;
    model: string;
    pricingModel: PricingModel;
    flatPrice?: string;
    perTokenPrice?: string;
    acceptedAssets?: PaymentAsset[];
    rateLimit?: number;
  }): Promise<RouteConfig> {
    const r = await prisma.route.create({
      data: {
        providerId: data.providerId,
        path: data.path,
        upstreamUrl: data.upstreamUrl,
        model: data.model,
        pricingModel: data.pricingModel,
        flatPrice: data.flatPrice,
        perTokenPrice: data.perTokenPrice,
        acceptedAssets: data.acceptedAssets || ['USDC'],
        rateLimit: data.rateLimit || 10,
      },
    });

    logger.info('Route created', { routeId: r.id, path: r.path, model: r.model });

    return toRouteConfig(r);
  }

  async update(
    id: string,
    data: Partial<{
      upstreamUrl: string;
      flatPrice: string;
      perTokenPrice: string;
      pricingModel: PricingModel;
      rateLimit: number;
      active: boolean;
    }>,
  ): Promise<RouteConfig> {
    const r = await prisma.route.update({ where: { id }, data });
    return toRouteConfig(r);
  }

  async delete(id: string): Promise<void> {
    await prisma.route.delete({ where: { id } });
    logger.info('Route deleted', { routeId: id });
  }
}
