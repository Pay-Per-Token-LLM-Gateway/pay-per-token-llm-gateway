import { LoadBalancerService } from './load-balancer.service';
import type { LoadBalancingConfig } from '@x402/types';

describe('LoadBalancerService', () => {
  let service: LoadBalancerService;

  const baseConfig: LoadBalancingConfig = {
    strategy: 'round_robin',
    failureThreshold: 2,
    cooldownMs: 30_000,
    upstreams: [
      { url: 'https://a.example.com/v1/chat/completions', name: 'a', weight: 1 },
      { url: 'https://b.example.com/v1/chat/completions', name: 'b', weight: 2 },
    ],
  };

  beforeEach(() => {
    service = new LoadBalancerService();
    jest.useRealTimers();
  });

  it('selects upstreams with weighted round robin', () => {
    const picks = Array.from(
      { length: 4 },
      () => service.selectUpstream('route-1', baseConfig).endpoint.name,
    );

    expect(picks).toEqual(['a', 'b', 'b', 'a']);
  });

  it('selects the upstream with the lowest observed latency', () => {
    const config = { ...baseConfig, strategy: 'least_latency' as const };
    service.recordSuccess('route-1', baseConfig.upstreams[0], 120);
    service.recordSuccess('route-1', baseConfig.upstreams[1], 40);

    expect(service.selectUpstream('route-1', config).endpoint.name).toBe('b');
  });

  it('opens a circuit after repeated failures and avoids that upstream', () => {
    service.recordFailure('route-1', baseConfig.upstreams[0], new Error('boom'), 2);
    service.recordFailure('route-1', baseConfig.upstreams[0], new Error('boom'), 2);

    const selected = service.selectUpstream('route-1', baseConfig);
    expect(selected.endpoint.name).toBe('b');

    const snapshot = service.getRouteSnapshot('route-1', baseConfig);
    expect(snapshot.find((item) => item.name === 'a')?.circuitOpen).toBe(true);
  });

  it('allows an unhealthy upstream back after cooldown', () => {
    jest.useFakeTimers();
    service.recordFailure('route-1', baseConfig.upstreams[0], new Error('boom'), 1);
    jest.advanceTimersByTime(30_000);

    const names = Array.from(
      { length: 3 },
      () => service.selectUpstream('route-1', baseConfig).endpoint.name,
    );

    expect(names).toContain('a');
  });
});
