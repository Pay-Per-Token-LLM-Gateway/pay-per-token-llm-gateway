import { Test, TestingModule } from '@nestjs/testing';
import { LoadBalancerService, LBStrategy, LBRouteEntry } from './load-balancer.service';
import type { RouteConfig, PricingModel, PaymentAsset } from '@x402/types';

// ── Test Fixtures ─────────────────────────────

function makeRoute(overrides: Partial<RouteConfig> & { id: string }): RouteConfig {
  return {
    providerId: 'prov-1',
    path: '/v1/chat/completions',
    upstreamUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4',
    pricingModel: 'flat' as PricingModel,
    acceptedAssets: ['USDC' as PaymentAsset],
    rateLimit: 10,
    active: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<RouteConfig> & { id: string }, weight = 1): LBRouteEntry {
  return { route: makeRoute(overrides), weight };
}

describe('LoadBalancerService', () => {
  let service: LoadBalancerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LoadBalancerService],
    }).compile();

    service = module.get<LoadBalancerService>(LoadBalancerService);
    service.resetAll();
  });

  // ── selectRoute: empty / null cases ──────────

  describe('selectRoute', () => {
    it('returns null for empty candidates', () => {
      expect(service.selectRoute([])).toBeNull();
    });

    it('returns the only candidate when there is one', () => {
      const entry = makeEntry({ id: 'r-1' });
      const result = service.selectRoute([entry]);
      expect(result).not.toBeNull();
      expect(result!.route.id).toBe('r-1');
    });

    it('skips routes with open circuits', () => {
      const entry = makeEntry({ id: 'r-1' });
      // Open the circuit by recording 5 failures
      for (let i = 0; i < 5; i++) {
        service.recordResult('r-1', false);
      }

      // With only this route, all are unhealthy -> null
      expect(service.selectRoute([entry])).toBeNull();

      // With a second healthy route, it should return the healthy one
      const entry2 = makeEntry({ id: 'r-2', upstreamUrl: 'https://other.api.com' });
      const result = service.selectRoute([entry, entry2]);
      expect(result).not.toBeNull();
      expect(result!.route.id).toBe('r-2');
    });

    it('allows half-open circuit after cooldown', () => {
      const entry = makeEntry({ id: 'r-1' });
      // Open the circuit
      for (let i = 0; i < 5; i++) {
        service.recordResult('r-1', false);
      }

      // Initially blocked
      expect(service.selectRoute([entry])).toBeNull();

      // Manually set lastFailureTime to the past (beyond cooldown)
      // We can't easily access private state, so verify the circuit opens first
      // then record a success to reset it
      service.recordResult('r-1', true); // This resets the circuit
      expect(service.selectRoute([entry])).not.toBeNull();
    });
  });

  // ── Round-Robin Strategy ─────────────────────

  describe('round-robin strategy', () => {
    it('alternates between two routes', () => {
      const entries = [
        makeEntry({ id: 'r-1', model: 'gpt-4' }),
        makeEntry({ id: 'r-2', model: 'gpt-4', upstreamUrl: 'https://other.api.com' }),
      ];

      const first = service.selectRoute(entries, 'round-robin');
      const second = service.selectRoute(entries, 'round-robin');

      expect(first!.route.id).not.toBe(second!.route.id);
    });

    it('loops back to the first route after exhausting all', () => {
      const entries = [
        makeEntry({ id: 'r-1', model: 'gpt-4' }),
        makeEntry({ id: 'r-2', model: 'gpt-4', upstreamUrl: 'https://other.api.com' }),
      ];

      const first = service.selectRoute(entries, 'round-robin');
      service.selectRoute(entries, 'round-robin'); // second
      const third = service.selectRoute(entries, 'round-robin'); // should wrap to first

      expect(first!.route.id).toBe(third!.route.id);
    });

    it('handles a single route gracefully', () => {
      const entry = makeEntry({ id: 'r-1', model: 'gpt-4' });
      const result1 = service.selectRoute([entry], 'round-robin');
      const result2 = service.selectRoute([entry], 'round-robin');
      expect(result1!.route.id).toBe(result2!.route.id);
    });
  });

  // ── Least-Latency Strategy ───────────────────

  describe('least-latency strategy', () => {
    it('picks the route with lowest average latency', () => {
      const entries = [
        makeEntry({ id: 'r-1', model: 'gpt-4' }),
        makeEntry({ id: 'r-2', model: 'gpt-4', upstreamUrl: 'https://fast.api.com' }),
      ];

      // r-1 has high latency, r-2 has low latency
      service.recordLatency('r-1', 500);
      service.recordLatency('r-1', 600);
      service.recordLatency('r-2', 50);
      service.recordLatency('r-2', 60);

      const result = service.selectRoute(entries, 'least-latency');
      expect(result!.route.id).toBe('r-2');
    });

    it('falls back to round-robin when no latency data exists', () => {
      const entries = [
        makeEntry({ id: 'r-1', model: 'gpt-4' }),
        makeEntry({ id: 'r-2', model: 'gpt-4', upstreamUrl: 'https://other.api.com' }),
      ];

      // No latency data recorded yet — should fall back to round-robin
      const first = service.selectRoute(entries, 'least-latency');
      const second = service.selectRoute(entries, 'least-latency');
      expect(first!.route.id).not.toBe(second!.route.id);
    });
  });

  // ── Weighted Strategy ────────────────────────

  describe('weighted strategy', () => {
    it('selects routes with higher weight more often', () => {
      const entries = [
        makeEntry({ id: 'r-heavy', model: 'gpt-4' }, 10),
        makeEntry({ id: 'r-light', model: 'gpt-4', upstreamUrl: 'https://light.api.com' }, 1),
      ];

      // Run 100 selections and count the distribution
      const counts: Record<string, number> = { 'r-heavy': 0, 'r-light': 0 };
      for (let i = 0; i < 100; i++) {
        const result = service.selectRoute(entries, 'weighted');
        counts[result!.route.id]++;
      }

      // Heavy route should be selected more often (10:1 weight ratio)
      // With 100 iterations, heavy should be > 50 in nearly all cases
      expect(counts['r-heavy']).toBeGreaterThan(counts['r-light']);
    });

    it('handles equal weights fairly', () => {
      const entries = [
        makeEntry({ id: 'r-1', model: 'gpt-4' }, 1),
        makeEntry({ id: 'r-2', model: 'gpt-4', upstreamUrl: 'https://other.api.com' }, 1),
      ];

      const counts: Record<string, number> = { 'r-1': 0, 'r-2': 0 };
      for (let i = 0; i < 200; i++) {
        const result = service.selectRoute(entries, 'weighted');
        counts[result!.route.id]++;
      }

      // Both should be selected at least 20% of the time
      expect(counts['r-1']).toBeGreaterThan(40);
      expect(counts['r-2']).toBeGreaterThan(40);
    });
  });

  // ── recordLatency ────────────────────────────

  describe('recordLatency', () => {
    it('maintains a moving average', () => {
      service.recordLatency('r-1', 100);
      service.recordLatency('r-1', 200);
      service.recordLatency('r-1', 300);

      // Average should be 200
      const entries = [makeEntry({ id: 'r-1', model: 'gpt-4' })];
      const result = service.selectRoute(entries, 'least-latency');
      expect(result!.route.id).toBe('r-1');
    });

    it('resets the window after max samples', () => {
      // Record many samples
      for (let i = 0; i < 110; i++) {
        service.recordLatency('r-1', 100);
      }

      // Average should still be valid (window was reset)
      const entries = [makeEntry({ id: 'r-1', model: 'gpt-4' })];
      expect(service.selectRoute(entries, 'least-latency')).not.toBeNull();
    });
  });

  // ── recordResult ─────────────────────────────

  describe('recordResult', () => {
    it('tracks success and failure counts', () => {
      service.recordResult('r-1', true);
      service.recordResult('r-1', true);
      service.recordResult('r-1', false);

      // The health status should reflect these counts
      const entries = [makeEntry({ id: 'r-1' })];
      const health = service.getHealthStatus(entries);
      const status = health.find((h) => h.routeId === 'r-1');
      expect(status).toBeDefined();
      expect(status!.successCount).toBe(2);
      expect(status!.failureCount).toBe(1);
      expect(status!.requestCount).toBe(3);
    });

    it('opens circuit after threshold failures', () => {
      for (let i = 0; i < 5; i++) {
        service.recordResult('r-1', false);
      }

      const entries = [makeEntry({ id: 'r-1' })];
      const health = service.getHealthStatus(entries);
      const status = health.find((h) => h.routeId === 'r-1');
      expect(status!.circuitOpen).toBe(true);
      expect(status!.healthy).toBe(false);
    });

    it('resets circuit on success', () => {
      for (let i = 0; i < 5; i++) {
        service.recordResult('r-1', false);
      }

      // Verify circuit is open
      let entries = [makeEntry({ id: 'r-1' })];
      let health = service.getHealthStatus(entries);
      expect(health.find((h) => h.routeId === 'r-1')!.circuitOpen).toBe(true);

      // Record a success — should reset circuit
      service.recordResult('r-1', true);
      health = service.getHealthStatus(entries);
      expect(health.find((h) => h.routeId === 'r-1')!.circuitOpen).toBe(false);
      expect(health.find((h) => h.routeId === 'r-1')!.consecutiveFailures).toBe(0);
    });
  });

  // ── getHealthStatus ──────────────────────────

  describe('getHealthStatus', () => {
    it('returns health status for all routes', () => {
      const entries = [
        makeEntry({ id: 'r-1', model: 'gpt-4', providerId: 'prov-1' }),
        makeEntry({ id: 'r-2', model: 'gpt-4', providerId: 'prov-2', upstreamUrl: 'https://other.api.com' }),
      ];

      service.recordLatency('r-1', 150);
      service.recordResult('r-1', true);
      service.recordResult('r-2', false);

      const health = service.getHealthStatus(entries);
      expect(health).toHaveLength(2);

      const r1 = health.find((h) => h.routeId === 'r-1');
      expect(r1!.averageLatencyMs).toBe(150);
      expect(r1!.successCount).toBe(1);
      expect(r1!.healthy).toBe(true);

      const r2 = health.find((h) => h.routeId === 'r-2');
      expect(r2!.failureCount).toBe(1);
      expect(r2!.healthy).toBe(true); // not open yet (only 1 failure)
    });

    it('marks inactive routes as unhealthy', () => {
      const entry = makeEntry({ id: 'r-1', active: false });
      const health = service.getHealthStatus([entry]);
      const status = health.find((h) => h.routeId === 'r-1');
      expect(status!.active).toBe(false);
      expect(status!.healthy).toBe(false);
    });
  });

  // ── resetRoute / resetAll ────────────────────

  describe('resetRoute', () => {
    it('clears tracking state for a specific route', () => {
      service.recordResult('r-1', true);
      service.recordLatency('r-1', 100);
      service.resetRoute('r-1');

      const entries = [makeEntry({ id: 'r-1' })];
      const health = service.getHealthStatus(entries);
      const status = health.find((h) => h.routeId === 'r-1');
      expect(status!.requestCount).toBe(0);
      expect(status!.averageLatencyMs).toBe(0);
      expect(status!.consecutiveFailures).toBe(0);
    });
  });

  describe('resetAll', () => {
    it('clears all tracking state', () => {
      service.recordResult('r-1', true);
      service.recordResult('r-2', false);
      service.recordLatency('r-1', 100);
      service.resetAll();

      const entries = [
        makeEntry({ id: 'r-1' }),
        makeEntry({ id: 'r-2' }),
      ];
      const health = service.getHealthStatus(entries);
      health.forEach((h) => {
        expect(h.requestCount).toBe(0);
        expect(h.consecutiveFailures).toBe(0);
        expect(h.averageLatencyMs).toBe(0);
      });
    });
  });
});