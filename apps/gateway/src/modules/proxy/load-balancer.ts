import { Injectable } from '@nestjs/common';
import type { RouteConfig, UpstreamConfig } from '@x402/types';
import { logger } from '@x402/logger';

@Injectable()
export class LoadBalancer {
  /**
   * Selects an upstream using a weighted random distribution.
   * Excludes any upstreams that are currently marked as open (failing) by the circuit breaker.
   */
  selectUpstream(
    route: RouteConfig,
    isCircuitOpen: (url: string) => boolean
  ): UpstreamConfig {
    if (!route.upstreams || route.upstreams.length === 0) {
      throw new Error(`No upstreams configured for route ${route.path}`);
    }

    // Filter active upstreams and those not failing in the circuit breaker
    const available = route.upstreams.filter(u => u.active && !isCircuitOpen(u.url));

    if (available.length === 0) {
      logger.error('All upstreams are failing or inactive', { routeId: route.id, path: route.path });
      throw new Error(`All upstreams for route ${route.path} are currently unavailable.`);
    }

    if (available.length === 1) {
        return available[0];
    }

    // Weighted random selection
    const totalWeight = available.reduce((sum, u) => sum + u.weight, 0);
    let random = Math.random() * totalWeight;

    for (const upstream of available) {
      random -= upstream.weight;
      if (random <= 0) {
        return upstream;
      }
    }

    return available[0];
  }
}
