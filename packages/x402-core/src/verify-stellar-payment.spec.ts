/* eslint-disable @typescript-eslint/no-explicit-any */
import { verifyStellarPayment, generateQuote } from './index';
import { unitsToStroops, stroopsToUnits } from '@x402/shared';

import type { Quote, RouteConfig, TxHash } from '@x402/types';

// ── Fixtures ──────────────────────────────────

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const TX_HASH: TxHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const PAYMENT_ADDRESS = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

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

function makeQuote(route: RouteConfig): Quote {
  return generateQuote({
    route,
    providerAddress: PAYMENT_ADDRESS,
    gatewayBaseUrl: 'http://localhost:3000',
    network: 'testnet',
    quoteExpirySeconds: 300,
    usdcIssuer: USDC_ISSUER,
  });
}

// ── Horizon mock helpers ──────────────────────

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data };
}

function errorResponse(status: number, statusText: string) {
  return { ok: false, status, statusText, json: async () => ({}) };
}

interface MockFetchOptions {
  tx?: unknown;
  ops?: unknown;
  txError?: { status: number; statusText: string };
  opsError?: { status: number; statusText: string };
  rejectWith?: Error;
}

function mockHorizonFetch(opts: MockFetchOptions) {
  return jest.fn().mockImplementation(async (url: string) => {
    if (opts.rejectWith) throw opts.rejectWith;
    if (url.includes('/operations')) {
      if (opts.opsError) return errorResponse(opts.opsError.status, opts.opsError.statusText);
      return jsonResponse(opts.ops);
    }
    if (opts.txError) return errorResponse(opts.txError.status, opts.txError.statusText);
    return jsonResponse(opts.tx);
  });
}

function txData(overrides: Record<string, unknown> = {}, quote?: Quote) {
  const memoFields =
    quote?.memo && overrides.memo === undefined && overrides.memo_type === undefined
      ? { memo_type: 'text', memo: quote.memo }
      : {};
  return {
    successful: true,
    source_account: 'GSOURCEACCOUNT123',
    ledger: 12345,
    created_at: new Date().toISOString(),
    ...memoFields,
    ...overrides,
  };
}

function opsData(records: unknown[] = []) {
  return { _embedded: { records } };
}

function paymentOp(overrides: Record<string, unknown> = {}) {
  return {
    type: 'payment',
    asset_code: 'USDC',
    asset_issuer: USDC_ISSUER,
    to: PAYMENT_ADDRESS,
    from: 'GPAYERACCOUNT123',
    // Realistic Horizon format: decimal string in asset units, e.g.
    // '0.1000000' = 0.1 USDC = 1_000_000 stroops.
    amount: '0.1000000',
    ...overrides,
  };
}

// ── Test harness ──────────────────────────────

const originalFetch = global.fetch;

afterEach(() => {
  (global as any).fetch = originalFetch;
});

// ── Amount unit conversion ────────────────────

describe('amount unit conversion (units ↔ stroops)', () => {
  it('converts Horizon decimal units to stroops', () => {
    expect(unitsToStroops('0.1000000')).toBe('1000000');
    expect(unitsToStroops('0.1')).toBe('1000000'); // trailing zeros may be omitted
    expect(unitsToStroops('0.0000500')).toBe('500');
    expect(unitsToStroops('0.0000001')).toBe('1');
    expect(unitsToStroops('10.5000000')).toBe('105000000');
  });

  it('converts stroops to decimal units for the stellar-sdk', () => {
    expect(stroopsToUnits('1000000')).toBe('0.1');
    expect(stroopsToUnits('2048000')).toBe('0.2048');
    expect(stroopsToUnits('500')).toBe('0.00005');
    expect(stroopsToUnits('1')).toBe('0.0000001');
    expect(stroopsToUnits('0')).toBe('0');
  });

  it('round-trips without loss', () => {
    for (const stroops of ['1', '500', '1000000', '2048000', '105000000']) {
      expect(unitsToStroops(stroopsToUnits(stroops))).toBe(stroops);
    }
  });
});

function verify(opts: { quote: Quote; txHash?: string; minPaymentAmount?: string }) {
  return verifyStellarPayment({
    txHash: opts.txHash ?? TX_HASH,
    quote: opts.quote,
    horizonUrl: HORIZON_URL,
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    ...(opts.minPaymentAmount !== undefined ? { minPaymentAmount: opts.minPaymentAmount } : {}),
  });
}

// ── Tests ─────────────────────────────────────

describe('verifyStellarPayment', () => {
  describe('Horizon transaction fetch', () => {
    it('returns not-found when Horizon responds 404', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        txError: { status: 404, statusText: 'Not Found' },
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('Transaction not found on chain');
    });

    it('returns a verification error when Horizon returns a non-404 error', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        txError: { status: 500, statusText: 'Internal Server Error' },
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe(
        'Verification error: Horizon error: 500 Internal Server Error',
      );
    });

    it('rejects a transaction that failed on chain', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        tx: txData(
          {
            successful: false,
            source_account: 'GSOURCEACCOUNT123',
            ledger: 42,
            created_at: '2026-01-01T00:00:00.000Z',
          },
          quote,
        ),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('Transaction failed on chain');
      expect(result.payerAddress).toBe('GSOURCEACCOUNT123');
      expect(result.ledger).toBe(42);
      expect(result.timestamp).toBe(Date.parse('2026-01-01T00:00:00.000Z') / 1000);
    });
  });

  describe('operations endpoint', () => {
    it('returns a verification error when the operations endpoint fails', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        opsError: { status: 500, statusText: 'Internal Server Error' },
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('Verification error: Horizon operations error: 500');
    });

    it('returns no match when the tx has no payment operations', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([{ type: 'create_account', account: 'GOTHER123', starting_balance: '10' }]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });

    it('returns no match when the ops response has no records', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({ tx: txData({}, quote), ops: {} });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });
  });

  describe('payment operation matching', () => {
    it('returns no match when the payment asset does not match the quote', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ asset_code: 'EURT', asset_issuer: 'GOTHER123' })]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });

    it('returns no match when the payment recipient differs from the quote address', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ to: 'GDESTINATION123' })]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });

    it('returns no match when an XLM (native) payment is sent for a USDC quote', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([
          paymentOp({ asset_type: 'native', asset_code: undefined, asset_issuer: undefined }),
        ]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });

    it('accepts path payment operations as payment operations', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([
          { type: 'manage_data', name: 'x', value: 'y' },
          {
            type: 'path_payment_strict_send',
            asset_code: 'USDC',
            asset_issuer: USDC_ISSUER,
            to: PAYMENT_ADDRESS,
            from: 'GPAYERACCOUNT123',
            amount: '0.1000000',
          },
        ]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(true);
      expect(result.amount).toBe('1000000');
    });
  });

  // Note: memo attribution is intentionally NOT enforced by the verifier —
  // the gateway retry flow verifies against a fresh quote, so requiring the
  // tx memo to match would reject every valid payment. See verifyStellarPayment.

  describe('flat-rate pricing', () => {
    it('verifies a flat-rate payment with an exact amount match (Horizon decimal units)', async () => {
      const quote = makeQuote(makeRoute()); // flat 1000000 stroops = 0.1 USDC
      (global as any).fetch = mockHorizonFetch({
        tx: txData({ ledger: 999, source_account: 'GSOURCEACCOUNT123' }, quote),
        ops: opsData([paymentOp({ amount: '0.1000000', from: 'GPAYERACCOUNT123' })]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(true);
      expect(result.payerAddress).toBe('GPAYERACCOUNT123');
      // amount is normalized to stroops, matching the quote unit
      expect(result.amount).toBe('1000000');
      expect(result.asset).toBe('USDC');
      expect(result.ledger).toBe(999);
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('verifies a flat-rate payment when Horizon omits trailing zeros', async () => {
      const quote = makeQuote(makeRoute()); // flat 1000000 stroops = 0.1 USDC
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        // Horizon can return '0.1' instead of '0.1000000' — both mean 0.1 USDC
        ops: opsData([paymentOp({ amount: '0.1' })]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(true);
      expect(result.amount).toBe('1000000');
    });

    it('returns no match for a flat-rate underpayment', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.0999999' })]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });

    it('returns no match for a flat-rate overpayment (exact match required)', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.2000000' })]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });
  });

  describe('minPaymentAmount enforcement', () => {
    // Flat route priced at 100,000 stroops (0.01 USDC); min is 200,000 stroops.
    function lowPricedQuote() {
      return makeQuote(makeRoute({ flatPrice: '100000', pricingModel: 'flat' }));
    }

    it('rejects a payment below the configured minimum', async () => {
      const quote = lowPricedQuote(); // quote = 100,000 stroops
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        // 0.015 USDC = 150,000 stroops: above the quote but below the min.
        ops: opsData([paymentOp({ amount: '0.0150000' })]),
      });

      const result = await verify({ quote, minPaymentAmount: '200000' });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });

    it('accepts a payment at the configured minimum', async () => {
      const quote = lowPricedQuote();
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.0200000' })]), // exactly 200,000 stroops
      });

      const result = await verify({ quote, minPaymentAmount: '200000' });

      expect(result.verified).toBe(true);
      expect(result.amount).toBe('200000');
    });

    it('rejects an overpayment on a flat route (exact match still required after clamping)', async () => {
      // Flat pricing requires an exact amount match: once the quote is
      // clamped up to the minimum, paying MORE than the required amount is
      // still a mismatch (no free change for the caller).
      const quote = lowPricedQuote(); // quote = 100,000 stroops → clamped to 200,000
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.0300000' })]), // 300,000 stroops > min
      });

      const result = await verify({ quote, minPaymentAmount: '200000' });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });

    it('accepts a per-token payment above the minimum (>= semantics)', async () => {
      // Per-token verification requires the payment to COVER the required
      // amount (deposit, clamped up to the minimum), so overpayment is fine.
      const quote = makeQuote(
        makeRoute({ pricingModel: 'per_token', perTokenPrice: '50', flatPrice: undefined }),
      ); // deposit = 50 × 4096 = 204,800 stroops; min 100,000 < deposit
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.0250000' })]), // 250,000 stroops ≥ 204,800
      });

      const result = await verify({ quote, minPaymentAmount: '100000' });

      expect(result.verified).toBe(true);
      expect(result.amount).toBe('250000');
    });

    it('clamps a degenerate quote up to the minimum (defense in depth)', async () => {
      // A quote generated before the min was configured (or with flatPrice=0)
      // must not grant access for a tiny payment when a min is set.
      const quote = makeQuote(makeRoute({ flatPrice: '0', pricingModel: 'flat' }));
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.0000001' })]), // 1 stroop
      });

      const result = await verify({ quote, minPaymentAmount: '10000' });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });

    it('does not enforce a minimum when none is configured', async () => {
      const quote = makeQuote(makeRoute({ flatPrice: '5000', pricingModel: 'flat' }));
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.0005000' })]), // exactly 5,000 stroops
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(true);
      expect(result.amount).toBe('5000');
    });
  });

  describe('per-token pricing', () => {
    function perTokenQuote() {
      return makeQuote(
        makeRoute({ pricingModel: 'per_token', perTokenPrice: '500', flatPrice: undefined }),
      );
    }

    it('verifies a per-token payment that covers the quoted deposit', async () => {
      const quote = perTokenQuote(); // deposit = 500 × 4096 default estimate = 2,048,000
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.2100000' })]), // 2,100,000 stroops ≥ deposit
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(true);
      expect(result.amount).toBe('2100000');
    });

    it('verifies a per-token payment exactly at the quoted deposit', async () => {
      const quote = perTokenQuote();
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.2048000' })]), // exactly 2,048,000 stroops
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(true);
      expect(result.amount).toBe('2048000');
    });

    it('rejects a per-token payment below the deposit even when it covers the per-token price', async () => {
      const quote = perTokenQuote(); // per-token price = 500, deposit = 2,048,000
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.0001000' })]), // 1,000 stroops ≥ 500 but < deposit
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe(
        'Payment amount is below the quoted deposit of 2048000 USDC',
      );
    });

    it('rejects a per-token payment of exactly one token at the per-token price', async () => {
      const quote = perTokenQuote();
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.0000500' })]), // 500 stroops
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe(
        'Payment amount is below the quoted deposit of 2048000 USDC',
      );
    });

    it('accepts a per-token payment when any operation in the tx covers the deposit', async () => {
      const quote = perTokenQuote();
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([
          paymentOp({ amount: '0.0001000' }), // 1,000 stroops — below deposit
          paymentOp({ amount: '0.2100000', from: 'GPAYERACCOUNT456' }), // covers deposit
        ]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(true);
      expect(result.amount).toBe('2100000');
      expect(result.payerAddress).toBe('GPAYERACCOUNT456');
    });

    it('returns no match when the quote amount is malformed', async () => {
      const quote = perTokenQuote();
      quote.amount = 'not-a-number';
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.2100000' })]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });

    it('uses a 1 stroop minimum when the per-token price is zero', async () => {
      const quote = makeQuote(
        makeRoute({ pricingModel: 'per_token', perTokenPrice: '0', flatPrice: undefined }),
      );

      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.0000000' })]), // 0 stroops
      });
      const zeroResult = await verify({ quote });
      expect(zeroResult.verified).toBe(false);

      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.0000001' })]), // 1 stroop
      });
      const oneStroopResult = await verify({ quote });
      expect(oneStroopResult.verified).toBe(true);
    });

    it('returns no match when the payment amount is not a valid integer', async () => {
      const quote = perTokenQuote();
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: 'not-a-number' })]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });
  });

  describe('quote expiry', () => {
    it('rejects a payment made after the quote expired', async () => {
      const quote = makeQuote(makeRoute());
      quote.expiresAt = Date.now() / 1000 - 60; // expired a minute ago
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([paymentOp({ amount: '0.1000000' })]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('Payment was made after quote expired');
    });
  });

  describe('XLM (native) asset', () => {
    it('verifies a native XLM payment for an XLM quote', async () => {
      const quote = makeQuote(
        makeRoute({ acceptedAssets: ['XLM'], flatPrice: '5000000', perTokenPrice: undefined }),
      );
      expect(quote.asset).toBe('XLM');

      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([
          {
            type: 'payment',
            asset_type: 'native',
            to: PAYMENT_ADDRESS,
            from: 'GPAYERACCOUNT123',
            amount: '0.5000000',
          },
        ]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(true);
      expect(result.asset).toBe('XLM');
      expect(result.amount).toBe('5000000');
    });

    it('returns no match when an issued asset is sent for an XLM quote', async () => {
      const quote = makeQuote(
        makeRoute({ acceptedAssets: ['XLM'], flatPrice: '5000000', perTokenPrice: undefined }),
      );
      (global as any).fetch = mockHorizonFetch({
        tx: txData({}, quote),
        ops: opsData([
          {
            type: 'payment',
            asset_type: 'credit_alphanum4',
            to: PAYMENT_ADDRESS,
            from: 'GPAYERACCOUNT123',
            amount: '0.5000000',
          },
        ]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('No matching payment operation found');
    });
  });

  describe('payer resolution', () => {
    it('falls back to the tx source account when the op has no from field', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({
        tx: txData({ source_account: 'GSOURCEACCOUNT123' }, quote),
        ops: opsData([
          {
            type: 'payment',
            asset_code: 'USDC',
            asset_issuer: USDC_ISSUER,
            to: PAYMENT_ADDRESS,
            amount: '0.1000000',
          },
        ]),
      });

      const result = await verify({ quote });

      expect(result.verified).toBe(true);
      expect(result.payerAddress).toBe('GSOURCEACCOUNT123');
    });
  });

  describe('fetch failures', () => {
    it('returns a verification error when Horizon fetch throws', async () => {
      const quote = makeQuote(makeRoute());
      (global as any).fetch = mockHorizonFetch({ rejectWith: new Error('network down') });

      const result = await verify({ quote });

      expect(result.verified).toBe(false);
      expect(result.failureReason).toBe('Verification error: network down');
    });
  });
});
