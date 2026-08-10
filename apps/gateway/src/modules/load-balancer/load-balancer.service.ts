import { Injectable } from '@nestjs/common';
import { prisma } from '@x402/database';
import { logger } from '@x402/logger';
import type { RouteConfig, PricingModel, PaymentAsset } from '@x402/types';

// ── Types ─────────────────────────────────────

export type LBStrategy = 'round-robin' | 'least-latency' | 'weighted';

/** A route entry tracked by the load balancer with runtime state. */
export interface LBRouteEntry {
  route: RouteConfig;
  weight: number;
}

/** Health status of a single route/upstream from the load balancer's perspective. */
export interface LBHealthStatus {
  routeId: string;
  providerId: string;
  model: string;
  upstreamUrl: string;
  weight: number;
  active: boolean;
  circuitOpen: boolean;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  averageLatencyMs: number;
  requestCount: number;
  successCount: number;
  failureCount: number;
  healthy: boolean;
}

// ── Circuit Breaker (per-route) ───────────────

interface CircuitState {
  failures: number;
  lastFailureTime: number;
  open: boolean;
}

// ── Latency Tracker (moving average) ──────────

interface LatencyStats {
  sum: number;
  count: number;
  average: number;
}

// ── Load Balancer Service ─────────────────────

@Injectable()
export class LoadBalancerService {
  /** Per-route round-robin index (keyed by `model:providerId:routeId`) */
  private readonly rrIndex = new Map<string, number>();

  /** Per-route circuit breaker state */
  private readonly circuits = new Map<string, CircuitState>();

  /** Per-route latency tracking (moving average of last 100 samples) */
  private readonly latencies = new Map<string, LatencyStats>();

  /** Per-route success/failure counters */
  private readonly counters = new Map<string, { success: number; failure: number; total: number }>();

  // ── Configuration ────────────────────────────

  private readonly failureThreshold = 5;
  private readonly cooldownMs = 30_000;
  private readonly maxLatencySamples = 100;

  // ── Route Discovery ──────────────────────────

  /**
   * Find all active routes that match the given path and model.
   * Used by the load balancer to select the best upstream.
   */
  async findAllRoutes(path: string, model: string): Promise<LBRouteEntry[]> {
    const rows = await prisma.route.findMany({
      where: { path, model, active: true },
      include: { provider: { select: { active: true } } },
    });

    return rows
      .filter((r) => r.provider.active)
      .map((r) => ({
        route: toRouteConfig(r),
        weight: r.weight ?? 1,
      }));
  }

  // ── Route Selection ──────────────────────────

  /**
   * Select the best upstream route from the available candidates.
   *
   * @param candidates - Active routes for the requested model
   * @param strategy  - Load balancing strategy
   * @returns The selected route entry, or null if no healthy route is available
   */
  selectRoute(
    candidates: LBRouteEntry[],
    strategy: LBStrategy = 'round-robin',
  ): LBRouteEntry | null {
    if (candidates.length === 0) return null;

    // Filter out candidates with open circuits
    const healthy = candidates.filter((c) => {
      const circuit = this.circuits.get(c.route.id);
      if (!circuit?.open) return true;
      // Half-open: allow test call after cooldown
      const elapsed = Date.now() - circuit.lastFailureTime;
      if (elapsed >= this.cooldownMs) {
        circuit.open = false;
        return true;
      }
      return false;
    });

    if (healthy.length === 0) {
      logger.warn('Load balancer: all upstreams have open circuits', {
        totalCandidates: candidates.length,
      });
      return null;
    }

    switch (strategy) {
      case 'least-latency':
        return this.selectLeastLatency(healthy);
      case 'weighted':
        return this.selectWeighted(healthy);
      case 'round-robin':
      default:
        return this.selectRoundRobin(healthy);
    }
  }

  // ── Strategy Implementations ─────────────────

  /**
   * Round-robin: distribute requests sequentially across healthy routes.
   * Uses a per-model counter to track the next index.
   */
  private selectRoundRobin(healthy: LBRouteEntry[]): LBRouteEntry {
    const model = healthy[0].route.model;
    const key = `rr:${model}`;
    const idx = (this.rrIndex.get(key) ?? 0) % healthy.length;
    this.rrIndex.set(key, idx + 1);
    return healthy[idx];
  }

  /**
   * Least-latency: pick the route with the lowest average response time.
   * Falls back to round-robin when no latency data is available for any route.
   */
  private selectLeastLatency(healthy: LBRouteEntry[]): LBRouteEntry {
    const withLatency = healthy
      .map((e) => ({
        entry: e,
        avg: this.latencies.get(e.route.id)?.average ?? Infinity,
      }))
      .sort((a, b) => a.avg - b.avg);

    // If all routes have no latency data (avg=Infinity), fall back to round-robin
    if (withLatency.every((wl) => wl.avg === Infinity)) {
      return this.selectRoundRobin(healthy);
    }

    return withLatency[0].entry;
  }

  /**
   * Weighted: distribute requests proportionally to assigned weights.
   * Uses a weighted random selection based on the configured weight value.
   */
  private selectWeighted(healthy: LBRouteEntry[]): LBRouteEntry {
    const totalWeight = healthy.reduce((sum, e) => sum + e.weight, 0);
    let random = Math.random() * totalWeight;

    for (const entry of healthy) {
      random -= entry.weight;
      if (random <= 0) return entry;
    }

    // Fallback (shouldn't happen with valid weights)
    return healthy[healthy.length - 1];
  }

  // ── Latency & Results Tracking ───────────────

  /**
   * Record the response time for a route (used by least-latency strategy).
   * Maintains a moving average of the last N samples.
   */
  recordLatency(routeId: string, latencyMs: number): void {
    let stats = this.latencies.get(routeId);
    if (!stats) {
      stats = { sum: 0, count: 0, average: 0 };
      this.latencies.set(routeId, stats);
    }

    // Simple moving average (last maxLatencySamples)
    if (stats.count >= this.maxLatencySamples) {
      // Reset window periodically to adapt to changing conditions
      stats.sum = 0;
      stats.count = 0;
    }

    stats.sum += latencyMs;
    stats.count++;
    stats.average = stats.sum / stats.count;
  }

  /**
   * Record the result of a request (success or failure).
   * Updates circuit breaker state and health counters.
   */
  recordResult(routeId: string, success: boolean): void {
    // Update counters
    const key = `cnt:${routeId}`;
    let c = this.counters.get(key);
    if (!c) {
      c = { success: 0, failure: 0, total: 0 };
      this.counters.set(key, c);
    }
    c.total++;
    if (success) {
      c.success++;
      // Record success — reset circuit
      this.circuits.delete(routeId);
    } else {
      c.failure++;
      // Record failure — increment circuit breaker
      const circuit = this.circuits.get(routeId) || {
        failures: 0,
        lastFailureTime: 0,
        open: false,
      };
      circuit.failures++;
      circuit.lastFailureTime = Date.now();
      if (circuit.failures >= this.failureThreshold) {
        circuit.open = true;
        logger.error('Load balancer: circuit breaker opened for route', {
          routeId,
          failures: circuit.failures,
          cooldownMs: this.cooldownMs,
        });
      }
      this.circuits.set(routeId, circuit);
    }
  }

  // ── Health Status ────────────────────────────

  /**
   * Get the health status of all tracked routes.
   * Used by the admin dashboard to display provider health.
   */
  getHealthStatus(allRoutes: LBRouteEntry[]): LBHealthStatus[] {
    return allRoutes.map((entry) => {
      const circuit = this.circuits.get(entry.route.id);
      const latency = this.latencies.get(entry.route.id);
      const cnt = this.counters.get(`cnt:${entry.route.id}`);
      const circuitOpen = circuit?.open ?? false;

      return {
        routeId: entry.route.id,
        providerId: entry.route.providerId,
        model: entry.route.model,
        upstreamUrl: entry.route.upstreamUrl,
        weight: entry.weight,
        active: entry.route.active,
        circuitOpen,
        consecutiveFailures: circuit?.failures ?? 0,
        lastFailureAt: circuit?.lastFailureTime
          ? new Date(circuit.lastFailureTime).toISOString()
          : null,
        averageLatencyMs: latency?.average ?? 0,
        requestCount: cnt?.total ?? 0,
        successCount: cnt?.success ?? 0,
        failureCount: cnt?.failure ?? 0,
        healthy: entry.route.active && !circuitOpen,
      };
    });
  }

  /**
   * Reset all tracking state for a specific route.
   */
  resetRoute(routeId: string): void {
    this.circuits.delete(routeId);
    this.latencies.delete(routeId);
    this.counters.delete(`cnt:${routeId}`);
  }

  /**
   * Reset all load balancer state.
   */
  resetAll(): void {
    this.rrIndex.clear();
    this.circuits.clear();
    this.latencies.clear();
    this.counters.clear();
  }
}

// ── Helper ─────────────────────────────────────

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
  metadata?: unknown;
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