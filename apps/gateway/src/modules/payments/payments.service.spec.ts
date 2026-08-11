// Author: RawNuke
// Copyright (c) 2026 RawNuke. All rights reserved.

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import type { Quote, RouteConfig, PaymentVerification } from '@x402/types';

// Mock @x402/database
jest.mock('@x402/database', () => ({
  prisma: {
    payment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
      aggregate: jest.fn(),
    },
    provider: {
      findFirst: jest.fn(),
    },
  },
}));

import { prisma } from '@x402/database';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: 'quote-1',
    route: '/v1/chat/completions',
    pricingModel: 'flat',
    amount: '1000000',
    asset: 'USDC',
    assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    paymentAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
    network: 'testnet',
    expiresAt: Date.now() / 1000 + 300,
    statusUrl: 'http://localhost:3000/api/v1/payments/quote-1/status',
    ...overrides,
  };
}

function makeRoute(overrides: Partial<RouteConfig> = {}): RouteConfig {
  return {
    id: 'route-1',
    providerId: 'provider-1',
    path: '/v1/chat/completions',
    upstreamUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4',
    pricingModel: 'flat',
    flatPrice: '1000000',
    acceptedAssets: ['USDC'],
    rateLimit: 10,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeVerification(overrides: Partial<PaymentVerification> = {}): PaymentVerification {
  return {
    verified: true,
    txHash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    payerAddress: 'GB4YJON6574K74SGHSKHPMBJDJPLBPYN4HPGGN2J5RFKMSNFSWLBYFRL',
    amount: '1000000',
    asset: 'USDC',
    ledger: 12345,
    timestamp: Date.now() / 1000,
    ...overrides,
  };
}

const OWNER = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';
const OTHER_OWNER = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK4G';

describe('PaymentsService', () => {
  let service: PaymentsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentsService],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);

    // Reset mocks
    jest.clearAllMocks();
  });

  describe('createPendingPayment', () => {
    it('creates a pending payment record', async () => {
      const quote = makeQuote();
      const route = makeRoute();

      (mockPrisma.payment.create as jest.Mock).mockResolvedValue({});

      await service.createPendingPayment(quote, route);

      expect(mockPrisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            quoteId: 'quote-1',
            routeId: 'route-1',
            providerId: 'provider-1',
            status: 'pending',
          }),
        }),
      );
    });
  });

  describe('confirmPayment (atomic single-use claim)', () => {
    function mockPaymentWithRoute() {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        quoteId: 'quote-1',
        routeId: 'route-1',
        route: {
          id: 'route-1',
          providerId: 'provider-1',
          path: '/v1/chat/completions',
        },
      });
    }

    it('confirms payment and returns the receipt when the claim wins', async () => {
      const verification = makeVerification();
      mockPaymentWithRoute();
      (mockPrisma.payment.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const receipt = await service.confirmPayment('quote-1', verification);

      expect(receipt).not.toBeNull();
      expect(receipt!.status).toBe('confirmed');
      expect(receipt!.txHash).toBe(verification.txHash);
      expect(receipt!.payerAddress).toBe(verification.payerAddress);
      expect(receipt!.amount).toBe(verification.amount);
      // The claim only touches un-consumed rows — where includes txHash: null.
      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { quoteId: 'quote-1', txHash: null },
        data: expect.objectContaining({
          txHash: verification.txHash,
          status: 'confirmed',
        }),
      });
    });

    it('populates the receipt route from the payment route path', async () => {
      const verification = makeVerification();
      mockPaymentWithRoute();
      (mockPrisma.payment.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const receipt = await service.confirmPayment('quote-1', verification);

      expect(receipt).not.toBeNull();
      expect(receipt!.route).toBe('/v1/chat/completions');
      expect(mockPrisma.payment.findFirst).toHaveBeenCalledWith({
        where: { quoteId: 'quote-1' },
        include: { route: true },
      });
    });

    it('returns null without claiming when the payment row is missing', async () => {
      const verification = makeVerification();
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);

      const receipt = await service.confirmPayment('quote-1', verification);

      expect(receipt).toBeNull();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    });

    it('returns null when the payment was already consumed (0 rows updated)', async () => {
      const verification = makeVerification();
      mockPaymentWithRoute();
      (mockPrisma.payment.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      const receipt = await service.confirmPayment('quote-1', verification);

      expect(receipt).toBeNull();
    });

    it('returns null on a concurrent unique-constraint violation', async () => {
      const verification = makeVerification();
      mockPaymentWithRoute();
      const violation = new Error('Unique constraint failed on the fields: (`txHash`)');
      (mockPrisma.payment.updateMany as jest.Mock).mockRejectedValue(violation);

      const receipt = await service.confirmPayment('quote-1', verification);

      expect(receipt).toBeNull();
    });
  });

  describe('findByQuoteId', () => {
    it('finds payment by quote ID', async () => {
      const mockPayment = { id: 'pay-1', quoteId: 'quote-1', status: 'confirmed' };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);

      const result = await service.findByQuoteId('quote-1');

      expect(mockPrisma.payment.findFirst).toHaveBeenCalledWith({ where: { quoteId: 'quote-1' } });
      expect(result).toEqual(mockPayment);
    });

    it('returns null if not found', async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      const result = await service.findByQuoteId('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('findByTxHash', () => {
    it('finds payment by transaction hash', async () => {
      const txHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
      const mockPayment = { id: 'pay-1', txHash, status: 'confirmed' };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);

      const result = await service.findByTxHash(txHash);

      expect(mockPrisma.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { txHash },
        }),
      );
      expect(result).toEqual(mockPayment);
    });
  });

  describe('findAll', () => {
    it("returns paginated payments scoped to the owner's providers", async () => {
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.payment.count as jest.Mock).mockResolvedValue(0);

      const result = await service.findAll({ page: 1, limit: 10 }, OWNER);

      expect(mockPrisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { provider: { walletAddress: OWNER } },
          skip: 0,
          take: 10,
        }),
      );
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
    });

    it('applies filters and serializes BigInt amounts', async () => {
      const createdAt = new Date('2026-08-10T10:00:00.000Z');
      const payments = [
        {
          id: 'pay-1',
          quoteId: 'quote-1',
          txHash: 'a1b2c3',
          payerAddress: 'GB4YJON6574K74SGHSKHPMBJDJPLBPYN4HPGGN2J5RFKMSNFSWLBYFRL',
          amount: BigInt('1000000'),
          asset: 'USDC',
          status: 'confirmed',
          verifiedAt: createdAt,
          routeId: 'route-1',
          providerId: 'provider-1',
          createdAt,
        },
      ];
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue(payments);
      (mockPrisma.payment.count as jest.Mock).mockResolvedValue(1);

      const result = await service.findAll(
        {
          providerId: 'provider-1',
          status: 'confirmed',
          payerAddress: 'GB4YJON6574K74SGHSKHPMBJDJPLBPYN4HPGGN2J5RFKMSNFSWLBYFRL',
          page: 2,
          limit: 5,
        },
        OWNER,
      );

      expect(mockPrisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            provider: { walletAddress: OWNER },
            providerId: 'provider-1',
            status: 'confirmed',
            payerAddress: 'GB4YJON6574K74SGHSKHPMBJDJPLBPYN4HPGGN2J5RFKMSNFSWLBYFRL',
          },
          skip: 5,
          take: 5,
        }),
      );
      expect(result.data[0].amount).toBe('1000000');
      expect(result.data[0].status).toBe('confirmed');
      expect(result.totalPages).toBe(1);
    });

    it('uses default page and limit when not provided', async () => {
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.payment.count as jest.Mock).mockResolvedValue(0);

      const result = await service.findAll({}, OWNER);

      expect(mockPrisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.totalPages).toBe(0);
    });
  });

  describe('recordActualCost', () => {
    it('updates the receipt with actual cost and token count', async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        quoteId: 'quote-1',
        amount: BigInt('1000000'),
        receiptJson: { id: 'quote-1', status: 'pending' },
      });
      (mockPrisma.payment.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.recordActualCost('quote-1', '850000', 123);

      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { quoteId: 'quote-1' },
        data: {
          receiptJson: {
            id: 'quote-1',
            status: 'pending',
            actualCost: '850000',
            tokensUsed: 123,
          },
        },
      });
    });

    it('handles a payment with a null receiptJson', async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        quoteId: 'quote-1',
        amount: BigInt('100'),
        receiptJson: null,
      });
      (mockPrisma.payment.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.recordActualCost('quote-1', '50', 5);

      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { quoteId: 'quote-1' },
        data: { receiptJson: { actualCost: '50', tokensUsed: 5 } },
      });
    });

    it('does nothing when the payment is not found', async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);

      await service.recordActualCost('missing-quote', '100', 1);

      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('returns payment statistics for an owned provider', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue({
        id: 'provider-1',
        walletAddress: OWNER,
      });
      (mockPrisma.payment.count as jest.Mock)
        .mockResolvedValueOnce(10) // confirmed
        .mockResolvedValueOnce(12); // total
      (mockPrisma.payment.aggregate as jest.Mock).mockResolvedValue({
        _sum: { amount: BigInt('50000000') },
      });

      const stats = await service.getStats('provider-1', OWNER);

      expect(mockPrisma.provider.findFirst).toHaveBeenCalledWith({
        where: { id: 'provider-1', walletAddress: OWNER },
      });
      expect(stats.totalPayments).toBe(12);
      expect(stats.confirmedPayments).toBe(10);
      expect(stats.failedPayments).toBe(2);
      expect(stats.totalRevenue).toBe('50000000');
    });

    it("throws NotFoundException for another wallet's provider", async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.getStats('provider-other', OTHER_OWNER)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.payment.count).not.toHaveBeenCalled();
      expect(mockPrisma.payment.aggregate).not.toHaveBeenCalled();
    });
  });
});
