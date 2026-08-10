/* istanbul ignore file */
import { Injectable } from '@nestjs/common';
import { logger } from '@x402/logger';
import type { LoadBalancedUpstream, LoadBalancingConfig } from '@x402/types';

interface EndpointState {
  failures: number;
  open: boolean;
  lastFailureTime: number;
  requestCount: number;
  totalLatencyMs: number;
  lastLatencyMs?: number;
  lastError?: string;
  lastCheckedAt?: string;
}

export interface SelectedUpstream {
  endpoint: LoadBalancedUpstream;
  endpointId: string;
}

export interface UpstreamHealthSnapshot {
  id: string;
  url: string;
  name?: string;
  weight: number;
  healthy: boolean;
  circuitOpen: boolean;
  failures: number;
  requestCount: number;
  averageLatencyMs: number;
  lastLatencyMs?: number;
  lastError?: string;
  lastCheckedAt?: string;
}

@Injectable()
export class LoadBalancerService {
  private readonly states = new Map<string, EndpointState>();
  private readonly roundRobinCursors = new Map<string, number>();

  selectUpstream(routeId: string, config: LoadBalancingConfig): SelectedUpstream {
    const failureThreshold = config.failureThreshold ?? 5;
    const cooldownMs = config.cooldownMs ?? 30_000;
    const weighted = this.expandWeightedEndpoints(config.upstreams);
    const candidates = weighted.filter((endpoint) =>
      this.isEndpointAvailable(routeId, endpoint, failureThreshold, cooldownMs),
    );

    if (candidates.length === 0) {
      throw new Error(`No healthy upstream providers available for route ${routeId}`);
    }

    const strategy = config.strategy ?? 'round_robin';
    const endpoint =
      strategy === 'least_latency'
        ? this.selectLeastLatency(routeId, candidates)
        : this.selectRoundRobin(routeId, candidates);

    return { endpoint, endpointId: this.getEndpointId(routeId, endpoint) };
  }

  recordSuccess(routeId: string, endpoint: LoadBalancedUpstream, latencyMs: number): void {
    const id = this.getEndpointId(routeId, endpoint);
    const state = this.states.get(id) ?? this.createState();
    state.failures = 0;
    state.open = false;
    state.requestCount += 1;
    state.totalLatencyMs += latencyMs;
    state.lastLatencyMs = latencyMs;
    state.lastError = undefined;
    state.lastCheckedAt = new Date().toISOString();
    this.states.set(id, state);
  }

  recordFailure(
    routeId: string,
    endpoint: LoadBalancedUpstream,
    error: unknown,
    failureThreshold = 5,
  ): void {
    const id = this.getEndpointId(routeId, endpoint);
    const state = this.states.get(id) ?? this.createState();
    state.failures += 1;
    state.lastFailureTime = Date.now();
    state.lastError = String(error instanceof Error ? error.message : error);
    state.lastCheckedAt = new Date().toISOString();

    if (state.failures >= failureThreshold) {
      state.open = true;
      logger.error('Load-balanced upstream circuit opened', {
        routeId,
        upstreamUrl: endpoint.url,
        failures: state.failures,
      });
    }

    this.states.set(id, state);
  }

  getRouteSnapshot(routeId: string, config: LoadBalancingConfig): UpstreamHealthSnapshot[] {
    return config.upstreams.map((endpoint) => {
      const state = this.states.get(this.getEndpointId(routeId, endpoint)) ?? this.createState();
      return {
        id: this.getEndpointId(routeId, endpoint),
        url: endpoint.url,
        name: endpoint.name,
        weight: endpoint.weight ?? 1,
        healthy: !state.open,
        circuitOpen: state.open,
        failures: state.failures,
        requestCount: state.requestCount,
        averageLatencyMs:
          state.requestCount === 0 ? 0 : Math.round(state.totalLatencyMs / state.requestCount),
        lastLatencyMs: state.lastLatencyMs,
        lastError: state.lastError,
        lastCheckedAt: state.lastCheckedAt,
      };
    });
  }

  getSnapshot(routes: Array<{ id: string; loadBalancing?: LoadBalancingConfig }>) {
    return routes
      .map((route) => {
        if (!route.loadBalancing?.upstreams.length) return null;
        return {
          routeId: route.id,
          strategy: route.loadBalancing.strategy ?? 'round_robin',
          upstreams: this.getRouteSnapshot(route.id, route.loadBalancing),
        };
      })
      .filter((route): route is NonNullable<typeof route> => route !== null);
  }

  private selectRoundRobin(
    routeId: string,
    endpoints: LoadBalancedUpstream[],
  ): LoadBalancedUpstream {
    const cursor = this.roundRobinCursors.get(routeId) ?? 0;
    const endpoint = endpoints[cursor % endpoints.length];
    this.roundRobinCursors.set(routeId, cursor + 1);
    return endpoint;
  }

  private selectLeastLatency(
    routeId: string,
    endpoints: LoadBalancedUpstream[],
  ): LoadBalancedUpstream {
    return [...endpoints].sort((a, b) => {
      const aState = this.states.get(this.getEndpointId(routeId, a));
      const bState = this.states.get(this.getEndpointId(routeId, b));
      const aLatency = aState?.requestCount
        ? aState.totalLatencyMs / aState.requestCount
        : Number.POSITIVE_INFINITY;
      const bLatency = bState?.requestCount
        ? bState.totalLatencyMs / bState.requestCount
        : Number.POSITIVE_INFINITY;
      return aLatency - bLatency || (b.weight ?? 1) - (a.weight ?? 1);
    })[0];
  }

  private expandWeightedEndpoints(endpoints: LoadBalancedUpstream[]): LoadBalancedUpstream[] {
    return endpoints.flatMap((endpoint) =>
      Array.from({ length: Math.max(1, endpoint.weight ?? 1) }, () => endpoint),
    );
  }

  private isEndpointAvailable(
    routeId: string,
    endpoint: LoadBalancedUpstream,
    failureThreshold: number,
    cooldownMs: number,
  ): boolean {
    const state = this.states.get(this.getEndpointId(routeId, endpoint));
    if (!state?.open) return true;

    const elapsed = Date.now() - state.lastFailureTime;
    if (elapsed >= cooldownMs) {
      state.open = false;
      state.failures = Math.max(0, failureThreshold - 1);
      logger.warn('Load-balanced upstream half-open', { routeId, upstreamUrl: endpoint.url });
      return true;
    }

    return false;
  }

  private getEndpointId(routeId: string, endpoint: LoadBalancedUpstream): string {
    return `${routeId}:${endpoint.name || endpoint.url}`;
  }

  private createState(): EndpointState {
    return {
      failures: 0,
      open: false,
      lastFailureTime: 0,
      requestCount: 0,
      totalLatencyMs: 0,
    };
  }
}
