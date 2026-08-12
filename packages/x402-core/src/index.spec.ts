import {
  generateQuote,
  buildPaymentRequiredResponse,
  calculatePrice,
  comparePayment,
  ReplayProtection,
  type RedisLike,
} from './index';

import type { RouteConfig, PaymentAsset, StellarNetwork } from '@x402/types';

function makeRoute(overrides: Partial<RouteConfig> = {}): RouteConfig {
  return {
    id: 'route-1',
    providerId: 'provider-1',
    path: '/v1/chat/completions',
    upstreamUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4',
    pricingModel: 'flat',
    flatPrice: '1000000',
    perTokenPrice: undefined,
    acceptedAssets: ['USDC'],
    rateLimit: 10,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('generateQuote', () => {
  it('generates a valid quote for a flat-rate route', () => {
    const route = makeRoute();
    const quote = generateQuote({
      route,
      providerAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
      gatewayBaseUrl: 'http://localhost:3000',
      network: 'testnet',
      quoteExpirySeconds: 300,
      usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    });

    expect(quote.id).toBeDefined();
    expect(quote.route).toBe('/v1/chat/completions');
    expect(quote.pricingModel).toBe('flat');
    expect(quote.amount).toBe('1000000');
    expect(quote.asset).toBe('USDC');
    expect(quote.assetIssuer).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    expect(quote.paymentAddress).toBe('GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F');
    expect(quote.network).toBe('testnet');
    expect(quote.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(quote.statusUrl).toContain('/api/v1/payments/');
  });

  it('derives a short deterministic memo from the quote id (attribution)', () => {
    const route = makeRoute();
    const quote = generateQuote({
      route,
      providerAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
      gatewayBaseUrl: 'http://localhost:3000',
      network: 'testnet',
      quoteExpirySeconds: 300,
      usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    });

    // MEMO_TEXT is capped at 28 bytes — the derived memo must be within limits
    // and stable for the same quote id.
    expect(quote.memo).toBeDefined();
    expect(quote.memo!.length).toBeLessThanOrEqual(28);
    expect(quote.memo).toBe(quote.id.replace(/-/g, '').slice(0, 24));
  });

  it('generates quote with per-token pricing (default token estimate)', () => {
    const route = makeRoute({
      pricingModel: 'per_token',
      perTokenPrice: '500',
      flatPrice: undefined,
    });
    const quote = generateQuote({
      route,
      providerAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
      gatewayBaseUrl: 'http://localhost:3000',
      network: 'mainnet',
      quoteExpirySeconds: 600,
      usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    });

    // 500 per token × 4096 default estimate = 2,048,000
    expect(quote.amount).toBe('2048000');
    expect(quote.pricingModel).toBe('per_token');
    expect(quote.network).toBe('mainnet');
    expect(quote.perTokenPrice).toBe('500');
    expect(quote.estimatedMaxTokens).toBe(4096);
  });

  it('generates quote with per-token pricing (custom token estimate)', () => {
    const route = makeRoute({
      pricingModel: 'per_token',
      perTokenPrice: '100',
      flatPrice: undefined,
    });
    const quote = generateQuote({
      route,
      providerAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
      gatewayBaseUrl: 'http://localhost:3000',
      network: 'testnet',
      quoteExpirySeconds: 300,
      usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      estimatedTokens: 256,
    });

    // 100 per token × 256 = 25,600
    expect(quote.amount).toBe('25600');
    expect(quote.estimatedMaxTokens).toBe(256);
  });

  it('defaults amount to 0 for missing price', () => {
    const route = makeRoute({ flatPrice: undefined, perTokenPrice: undefined });
    const quote = generateQuote({
      route,
      providerAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
      gatewayBaseUrl: 'http://localhost:3000',
      network: 'testnet',
      quoteExpirySeconds: 300,
      usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    });

    expect(quote.amount).toBe('0');
  });
});

describe('generateQuote minPaymentAmount enforcement', () => {
  const base = {
    providerAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
    gatewayBaseUrl: 'http://localhost:3000',
    network: 'testnet' as const,
    quoteExpirySeconds: 300,
    usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  };

  it('leaves quotes above the minimum unchanged', () => {
    const route = makeRoute({ flatPrice: '20000', pricingModel: 'flat' });
    const quote = generateQuote({ ...base, route, minPaymentAmount: '10000' });

    expect(quote.amount).toBe('20000');
  });

  it('clamps quotes below the minimum up to the minimum (free-access guard)', () => {
    // flatPrice=0 must not result in free access when a minimum is configured.
    const route = makeRoute({ flatPrice: '0', pricingModel: 'flat' });
    const quote = generateQuote({ ...base, route, minPaymentAmount: '10000' });

    expect(quote.amount).toBe('10000');
  });

  it('accepts quotes exactly at the minimum', () => {
    const route = makeRoute({ flatPrice: '10000', pricingModel: 'flat' });
    const quote = generateQuote({ ...base, route, minPaymentAmount: '10000' });

    expect(quote.amount).toBe('10000');
  });

  it('clamps degenerate per-token deposits to the minimum', () => {
    const route = makeRoute({
      pricingModel: 'per_token',
      perTokenPrice: '0',
      flatPrice: undefined,
    });
    const quote = generateQuote({ ...base, route, minPaymentAmount: '10000' });

    expect(quote.amount).toBe('10000');
  });

  it('does not clamp when no minimum is configured', () => {
    const route = makeRoute({ flatPrice: '0', pricingModel: 'flat' });
    const quote = generateQuote({ ...base, route });

    expect(quote.amount).toBe('0');
  });
});

describe('buildPaymentRequiredResponse', () => {
  it('builds a valid 402 response', () => {
    const route = makeRoute();
    const quote = generateQuote({
      route,
      providerAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
      gatewayBaseUrl: 'http://localhost:3000',
      network: 'testnet',
      quoteExpirySeconds: 300,
      usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    });

    const response = buildPaymentRequiredResponse({
      quote,
      gatewayBaseUrl: 'http://localhost:3000',
    });

    expect(response.status).toBe(402);
    expect(response.message).toBe('Payment Required');
    expect(response.quote).toEqual(quote);
    expect(response.instructions).toContain(quote.paymentAddress);
    expect(response.instructions).toContain('X-Payment-Hash');
    expect(response.docs).toBe('http://localhost:3000/docs/x402');
  });
});

describe('calculatePrice', () => {
  it('calculates flat price', () => {
    const route = makeRoute({ flatPrice: '1000000', pricingModel: 'flat' });
    const result = calculatePrice({ route });

    expect(result.amount).toBe('1000000');
    expect(result.asset).toBe('USDC');
  });

  it('calculates per-token price', () => {
    const route = makeRoute({
      perTokenPrice: '100',
      pricingModel: 'per_token',
      flatPrice: undefined,
    });
    const result = calculatePrice({ route, tokenCount: 500 });

    expect(result.amount).toBe('50000');
    expect(result.asset).toBe('USDC');
  });

  it('returns 0 for missing price', () => {
    const route = makeRoute({ flatPrice: undefined });
    const result = calculatePrice({ route });

    expect(result.amount).toBe('0');
  });
});

describe('comparePayment', () => {
  it('detects exact payment', () => {
    const result = comparePayment('1000000', '1000000');
    expect(result.surplus).toBe('0');
    expect(result.isOverpaid).toBe(false);
    expect(result.isUnderpaid).toBe(false);
  });

  it('detects overpayment', () => {
    const result = comparePayment('2000000', '1000000');
    expect(result.surplus).toBe('1000000');
    expect(result.isOverpaid).toBe(true);
    expect(result.isUnderpaid).toBe(false);
  });

  it('detects underpayment', () => {
    const result = comparePayment('500000', '1000000');
    expect(result.surplus).toBe('-500000');
    expect(result.isOverpaid).toBe(false);
    expect(result.isUnderpaid).toBe(true);
  });
});

describe('ReplayProtection', () => {
  it('marks and detects used payments (in-memory fallback)', async () => {
    const rp = new ReplayProtection();
    const txHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

    await expect(rp.isUsed(txHash)).resolves.toBe(false);
    await rp.markUsed(txHash, 60);
    await expect(rp.isUsed(txHash)).resolves.toBe(true);
    expect(rp.size).toBe(1);
  });

  it('tracks multiple payments (in-memory fallback)', async () => {
    const rp = new ReplayProtection();
    const hash1 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
    const hash2 = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3';

    await rp.markUsed(hash1, 60);
    await rp.markUsed(hash2, 60);

    await expect(rp.isUsed(hash1)).resolves.toBe(true);
    await expect(rp.isUsed(hash2)).resolves.toBe(true);
    expect(rp.size).toBe(2);
  });

  it('auto-expires entries (in-memory fallback)', async () => {
    jest.useFakeTimers();
    const rp = new ReplayProtection();
    const hash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

    await rp.markUsed(hash, 1); // 1 second TTL
    await expect(rp.isUsed(hash)).resolves.toBe(true);

    jest.runAllTimers();
    // After the timer fires, the entry should be removed
    expect(rp.size).toBe(0);

    jest.useRealTimers();
  });

  it('uses Redis when client is provided', async () => {
    const mockRedis: RedisLike = {
      exists: jest.fn(),
      set: jest.fn(),
    };

    const txHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
    const rp = new ReplayProtection(mockRedis);

    // Not used yet
    (mockRedis.exists as jest.Mock).mockResolvedValue(0);
    await expect(rp.isUsed(txHash)).resolves.toBe(false);
    expect(mockRedis.exists).toHaveBeenCalledWith('x402:replay:' + txHash);

    // Mark used
    await rp.markUsed(txHash, 120);
    expect(mockRedis.set).toHaveBeenCalledWith('x402:replay:' + txHash, '1', 'EX', '120');

    // Now reports as used
    (mockRedis.exists as jest.Mock).mockResolvedValue(1);
    await expect(rp.isUsed(txHash)).resolves.toBe(true);
  });

  it('atomically claims a hash exactly once via Redis SET NX', async () => {
    const mockRedis: RedisLike = {
      exists: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const txHash = 'c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2';
    const rp = new ReplayProtection(mockRedis);

    // First claim wins
    await expect(rp.claim(txHash, 3600)).resolves.toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith('x402:replay:' + txHash, '1', 'EX', '3600', 'NX');

    // A concurrent caller that loses the claim receives false
    (mockRedis.set as jest.Mock).mockResolvedValueOnce(null);
    await expect(rp.claim(txHash, 3600)).resolves.toBe(false);
  });

  it('claims exactly once in the in-memory fallback', async () => {
    const rp = new ReplayProtection();
    const txHash = 'd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2';

    await expect(rp.claim(txHash, 60)).resolves.toBe(true);
    await expect(rp.claim(txHash, 60)).resolves.toBe(false);
    await expect(rp.isUsed(txHash)).resolves.toBe(true);
  });
});
