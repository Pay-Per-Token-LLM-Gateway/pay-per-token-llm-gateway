import { X402Service } from './x402.service';
import { loadConfig, setConfig } from '@x402/config';
import { isPaymentUsedOnChain, recordPaymentOnChain } from './contract-client';
import { verifyStellarPayment } from '@x402/x402-core';
import type { PaymentVerification, Quote, RouteConfig } from '@x402/types';

// On-chain calls must never hit a real Soroban RPC in unit tests.
jest.mock('./contract-client', () => ({
  isPaymentUsedOnChain: jest.fn(),
  recordPaymentOnChain: jest.fn(),
}));

// Keep the pure quote/receipt builders real; stub only the Horizon call.
jest.mock('@x402/x402-core', () => {
  const actual = jest.requireActual('@x402/x402-core');
  return { ...actual, verifyStellarPayment: jest.fn() };
});

const mockIsPaymentUsedOnChain = isPaymentUsedOnChain as jest.Mock;
const mockRecordPaymentOnChain = recordPaymentOnChain as jest.Mock;
const mockVerifyStellarPayment = verifyStellarPayment as jest.Mock;

const baseConfig = loadConfig();

const route: RouteConfig = {
  id: 'route-1',
  providerId: 'prov-1',
  path: '/v1/chat/completions',
  upstreamUrl: 'https://api.example.com/v1/chat/completions',
  model: 'gpt-4',
  pricingModel: 'flat',
  flatPrice: '50000', // above the default 10000-stroop minPaymentAmount (no clamp)
  acceptedAssets: ['USDC'],
  rateLimit: 10,
  active: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const quote: Quote = {
  id: 'quote-1',
  route: route.path,
  pricingModel: 'flat',
  amount: '500',
  asset: 'USDC',
  paymentAddress: 'GA7QNFARKGM6Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q',
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  network: 'testnet',
  statusUrl: 'https://gateway.local/payments/quote-1',
};

const txHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

const verifiedVerification: PaymentVerification = {
  verified: true,
  txHash,
  payerAddress: 'GA7QNFARKGM6Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q',
  amount: '500',
  asset: 'USDC',
  ledger: 123,
  timestamp: 1700000000,
  failureReason: '',
};

// Minimal RedisLike: `exists` drives replay state, `set` drives the
// claim race (null → claim lost, 'OK' → claim won).
const redis = {
  exists: jest.fn().mockResolvedValue(0),
  set: jest.fn().mockResolvedValue('OK'),
};

interface ServiceHarness {
  service: X402Service;
  prisma: { provider: { findUnique: jest.Mock } };
}

function buildService(): ServiceHarness {
  const prisma = {
    provider: { findUnique: jest.fn() },
  };
  const service = new X402Service(prisma as never, redis as never);
  return { service, prisma };
}

describe('X402Service', () => {
  beforeEach(() => {
    // Restore mock defaults. `jest.clearAllMocks()` only resets call history,
    // not implementations — without this, a `mockResolvedValue(null)` from one
    // test leaks into the next (e.g. the replay-claim test) and every later
    // `claim()` silently fails.
    redis.exists.mockResolvedValue(0);
    redis.set.mockResolvedValue('OK');
  });

  afterEach(() => {
    setConfig(baseConfig);
    jest.clearAllMocks();
  });

  describe('generateQuoteForRoute', () => {
    it('generates a quote using the provider wallet from the database', async () => {
      const { service, prisma } = buildService();
      prisma.provider.findUnique.mockResolvedValue({
        id: 'prov-1',
        walletAddress: 'GA7Q...WALLET',
      });

      const generated = await service.generateQuoteForRoute(route);

      expect(prisma.provider.findUnique).toHaveBeenCalledWith({ where: { id: 'prov-1' } });
      expect(generated.route).toBe(route.path);
      expect(generated.paymentAddress).toBe('GA7Q...WALLET');
      expect(generated.amount).toBe('50000');
    });

    it('clamps a below-minimum flat price up to minPaymentAmount', async () => {
      const { service, prisma } = buildService();
      prisma.provider.findUnique.mockResolvedValue({
        id: 'prov-1',
        walletAddress: 'GA7Q...WALLET',
      });
      const cheapRoute = { ...route, flatPrice: '500' }; // below the 10000-stroop default minimum

      const generated = await service.generateQuoteForRoute(cheapRoute);

      expect(generated.amount).toBe('10000'); // minPaymentAmount default
    });

    it('falls back to an empty provider address when the provider row is missing', async () => {
      const { service, prisma } = buildService();
      prisma.provider.findUnique.mockResolvedValue(null);

      const generated = await service.generateQuoteForRoute(route);

      expect(generated.paymentAddress).toBe('');
    });
  });

  describe('build402Response', () => {
    it('builds a payment-required response from the quote', async () => {
      const { service } = buildService();
      const response = await service.build402Response(quote);
      expect(response).toMatchObject({ status: 402 });
    });
  });

  describe('verifyPayment', () => {
    it('rejects a hash that loses the replay-protection claim', async () => {
      const { service } = buildService();
      redis.set.mockResolvedValue(null); // SET NX lost → concurrent caller won

      const result = await service.verifyPayment(txHash, quote);

      expect(result.verified).toBe(false);
      expect(result.failureReason).toContain('replay');
    });

    it('rejects a hash already recorded on-chain', async () => {
      const { service } = buildService();
      mockIsPaymentUsedOnChain.mockResolvedValue(true);

      const result = await service.verifyPayment(txHash, quote);

      expect(result.verified).toBe(false);
      expect(result.failureReason).toContain('on-chain replay protection');
      expect(redis.set).toHaveBeenCalled(); // markUsed extends the Redis claim
    });

    it('verifies an unused payment via Horizon', async () => {
      const { service } = buildService();
      mockIsPaymentUsedOnChain.mockResolvedValue(false);
      mockVerifyStellarPayment.mockResolvedValue(verifiedVerification);

      const result = await service.verifyPayment(txHash, quote);

      expect(result.verified).toBe(true);
      expect(result.amount).toBe('500');
      expect(mockVerifyStellarPayment).toHaveBeenCalledWith(
        expect.objectContaining({ txHash, quote }),
      );
    });

    it('records a verified payment on-chain when CONTRACT_ADMIN_SECRET is set', async () => {
      setConfig({
        ...baseConfig,
        payment: { ...baseConfig.payment, contractAdminSecret: 'SCONTRACTADMINSECRET1234567890' },
      });
      const { service } = buildService();
      mockIsPaymentUsedOnChain.mockResolvedValue(false);
      mockVerifyStellarPayment.mockResolvedValue(verifiedVerification);

      await service.verifyPayment(txHash, quote);

      expect(mockRecordPaymentOnChain).toHaveBeenCalledWith(
        expect.objectContaining({ txHash, quoteId: 'quote-1' }),
      );
    });

    it('skips the on-chain audit trail when CONTRACT_ADMIN_SECRET is unset', async () => {
      const { service } = buildService();
      mockIsPaymentUsedOnChain.mockResolvedValue(false);
      mockVerifyStellarPayment.mockResolvedValue(verifiedVerification);

      await service.verifyPayment(txHash, quote);

      expect(mockRecordPaymentOnChain).not.toHaveBeenCalled();
    });
  });

  describe('generateReceipt / isQuoteExpired', () => {
    it('generates a receipt from a verification', () => {
      const { service } = buildService();
      const receipt = service.generateReceipt(verifiedVerification, quote);
      expect(receipt.quoteId).toBe('quote-1');
    });

    it('detects expired quotes', () => {
      const { service } = buildService();
      expect(
        service.isQuoteExpired({ ...quote, expiresAt: Math.floor(Date.now() / 1000) - 10 }),
      ).toBe(true);
      expect(service.isQuoteExpired(quote)).toBe(false);
    });
  });
});
