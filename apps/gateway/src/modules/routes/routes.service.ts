import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, prisma } from '@x402/database';
import { logger } from '@x402/logger';
import type { RouteConfig, PricingModel, PaymentAsset, LoadBalancingConfig } from '@x402/types';

/**
 * Expand an incoming request path into the candidate route paths that may
 * match it.
 *
 * Route `path` values are configured OpenAI-style with a leading `/v1`
 * (e.g. `/v1/chat/completions`). The gateway's own global prefix is
 * `/api/v1`, so a caller's `/api/v1/chat/completions` maps to the stored
 * route `/v1/chat/completions` — not to `/chat/completions` (the path left
 * after stripping the prefix). To stay robust across both conventions
 * (with and without `/v1`), all plausible forms are generated and any of
 * them may match.
 *
 * Examples:
 *   '/api/v1/chat/completions' → ['/api/v1/chat/completions', '/chat/completions', '/v1/chat/completions']
 *   '/v1/chat/completions'     → ['/v1/chat/completions', '/chat/completions']
 *   '/chat/completions'        → ['/chat/completions', '/v1/chat/completions']
 */
export function buildRoutePathCandidates(requestPath: string): string[] {
  // Strip the gateway's global prefix when the caller included it
  // (e.g. `/api/v1/chat/completions` → `/chat/completions`).
  const stripped = requestPath.replace(/^\/api\/v1(?=\/|$)/, '') || requestPath;

  // Express (non-strict routing) forwards `/api/v1/chat/completions/` with
  // the trailing slash intact; trim it so it matches stored route paths.
  const normalized = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  const normalizedRequest = normalized(requestPath);
  const normalizedStripped = normalized(stripped);

  const candidates = new Set<string>([normalizedRequest, normalizedStripped]);

  // The documented route convention is OpenAI-style `/v1/...`. The gateway
  // prefix can absorb that `/v1`, so also try the `/v1`-prefixed form.
  if (!normalizedStripped.startsWith('/v1')) {
    candidates.add(`/v1${normalizedStripped}`);
  } else {
    // Bare form, in case a route is configured without the `/v1` prefix.
    candidates.add(normalizedStripped.replace(/^\/v1/, ''));
  }

  return [...candidates];
}

/**
 * Map a raw Prisma route row to the typed RouteConfig response.
 */
function toRouteConfig(r: {
  id: string;
  providerId: string;
  path: string;
  upstreamUrl: string;
  loadBalancing?: unknown | null;
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
    loadBalancing: normalizeLoadBalancing(r.loadBalancing),
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

function normalizeLoadBalancing(
  value: unknown | null | undefined,
): LoadBalancingConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const config = value as LoadBalancingConfig;
  if (!Array.isArray(config.upstreams) || config.upstreams.length < 2) return undefined;
  return config;
}

@Injectable()
export class RoutesService {
  /**
   * List routes belonging to the authenticated wallet's providers.
   * A route is only visible if its provider's `walletAddress` matches the
   * caller — this prevents cross-tenant reads.
   */
  async findAll(ownerAddress: string, providerId?: string): Promise<RouteConfig[]> {
    const routes = await prisma.route.findMany({
      where: {
        provider: { walletAddress: ownerAddress },
        ...(providerId ? { providerId } : {}),
      },
    });

    return routes.map(toRouteConfig);
  }

  /**
   * Public lookup used by the proxy to resolve a route for an incoming
   * request — intentionally not wallet-scoped (callers are unauthenticated
   * clients paying for access).
   */
  async findByPathAndModel(path: string, model: string): Promise<RouteConfig | null> {
    const r = await prisma.route.findFirst({
      where: { path: { in: buildRoutePathCandidates(path) }, model, active: true },
    });

    if (!r) return null;

    return toRouteConfig(r);
  }

  async findById(id: string, ownerAddress: string): Promise<RouteConfig> {
    const r = await prisma.route.findFirst({
      where: { id, provider: { walletAddress: ownerAddress } },
    });
    if (!r) throw new NotFoundException(`Route ${id} not found`);

    return toRouteConfig(r);
  }

  /**
   * Create a route. The target provider must be owned by the authenticated
   * wallet — otherwise anyone could register a route on someone else's
   * provider (and receive their payments).
   */
  async create(
    data: {
      providerId: string;
      path: string;
      upstreamUrl: string;
      loadBalancing?: LoadBalancingConfig;
      model: string;
      pricingModel: PricingModel;
      flatPrice?: string;
      perTokenPrice?: string;
      acceptedAssets?: PaymentAsset[];
      rateLimit?: number;
    },
    ownerAddress: string,
  ): Promise<RouteConfig> {
    const provider = await prisma.provider.findFirst({
      where: { id: data.providerId, walletAddress: ownerAddress },
    });
    if (!provider) {
      throw new NotFoundException(`Provider ${data.providerId} not found`);
    }

    const r = await prisma.route.create({
      data: {
        providerId: data.providerId,
        path: data.path,
        upstreamUrl: data.upstreamUrl,
        loadBalancing: data.loadBalancing as Prisma.InputJsonValue | undefined,
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
      loadBalancing: LoadBalancingConfig | null;
      flatPrice: string;
      perTokenPrice: string;
      pricingModel: PricingModel;
      rateLimit: number;
      active: boolean;
    }>,
    ownerAddress: string,
  ): Promise<RouteConfig> {
    // Ownership check first — only the wallet that owns the parent provider
    // may edit this route.
    const existing = await prisma.route.findFirst({
      where: { id, provider: { walletAddress: ownerAddress } },
    });
    if (!existing) throw new NotFoundException(`Route ${id} not found`);

    const updateData = {
      ...data,
      ...(data.loadBalancing === null
        ? { loadBalancing: Prisma.JsonNull }
        : { loadBalancing: data.loadBalancing as Prisma.InputJsonValue | undefined }),
    };

    const r = await prisma.route.update({ where: { id }, data: updateData });
    return toRouteConfig(r);
  }

  async delete(id: string, ownerAddress: string): Promise<void> {
    // Ownership-scoped delete: only deletes if the route belongs to a
    // provider owned by the caller.
    const result = await prisma.route.deleteMany({
      where: { id, provider: { walletAddress: ownerAddress } },
    });
    if (result.count === 0) {
      throw new NotFoundException(`Route ${id} not found`);
    }
    logger.info('Route deleted', { routeId: id });
  }
}
