import { Test, TestingModule } from '@nestjs/testing';
import { ProvidersService } from './providers.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { validateWebhookUrl } from '../webhooks/webhooks.service';

// Mock @x402/database
jest.mock('@x402/database', () => ({
  prisma: {
    provider: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

// Mock the SSRF guard so no real DNS lookups happen in tests.
jest.mock('../webhooks/webhooks.service', () => ({
  validateWebhookUrl: jest.fn(),
}));

// Mock @x402/config so tests can control the approval flags.
const mockConfig = {
  security: {
    providerApprovalRequired: false,
    allowPayoutEqualsAuthWallet: false,
  },
};
jest.mock('@x402/config', () => ({
  getConfig: jest.fn(() => mockConfig),
}));

import { prisma } from '@x402/database';
import { getConfig } from '@x402/config';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockValidateWebhookUrl = validateWebhookUrl as jest.MockedFunction<typeof validateWebhookUrl>;
const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;

const WALLET = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';
const OTHER_WALLET = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK4G';
// A valid but different Stellar public key for payout-twice tests.
const PAYOUT_WALLET = 'GABMBNNZQQPY7ZBBFBNPPQH2BRAYQ7LRTLPAWGZ7XTUFUEEX2VOILYHK';

function makeProvider(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p-1',
    name: 'Test Provider',
    walletAddress: WALLET,
    payoutWalletAddress: null,
    webhookUrl: null,
    active: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    routes: [],
    ...overrides,
  };
}

describe('ProvidersService', () => {
  let service: ProvidersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProvidersService],
    }).compile();

    service = module.get<ProvidersService>(ProvidersService);
    jest.clearAllMocks();
    // Default: any non-empty URL passes the SSRF guard unchanged.
    mockValidateWebhookUrl.mockImplementation(async (url) => url);
    // Reset config defaults each test.
    mockConfig.security.providerApprovalRequired = false;
    mockConfig.security.allowPayoutEqualsAuthWallet = false;
  });

  describe('findAll', () => {
    it('returns only providers owned by the authenticated wallet', async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([makeProvider()]);

      const result = await service.findAll(WALLET);

      expect(mockPrisma.provider.findMany).toHaveBeenCalledWith({
        where: { walletAddress: WALLET },
        include: { routes: true },
      });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Test Provider');
      expect(result[0].active).toBe(true);
    });
  });

  describe('findById', () => {
    it('returns a provider owned by the wallet', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(makeProvider());

      const result = await service.findById('p-1', WALLET);

      expect(mockPrisma.provider.findFirst).toHaveBeenCalledWith({
        where: { id: 'p-1', walletAddress: WALLET },
        include: { routes: true },
      });
      expect(result.name).toBe('Test Provider');
      expect(result.id).toBe('p-1');
    });

    it('throws NotFoundException for a provider owned by another wallet', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.findById('p-other', OTHER_WALLET)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for missing provider', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.findById('nonexistent', WALLET)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a provider owned by the authenticated wallet, ignoring body walletAddress', async () => {
      const mockCreated = makeProvider({ id: 'new-id', name: 'New Provider' });
      (mockPrisma.provider.create as jest.Mock).mockResolvedValue(mockCreated);

      const result = await service.create(
        {
          name: 'New Provider',
          payoutWalletAddress: OTHER_WALLET,
        },
        WALLET,
      );

      // The provider's walletAddress is always the authenticated wallet —
      // never derived from the request body.
      expect(mockPrisma.provider.create).toHaveBeenCalledWith({
        data: {
          name: 'New Provider',
          walletAddress: WALLET,
          payoutWalletAddress: OTHER_WALLET,
          webhookUrl: null,
          webhookSecret: null,
          metadata: {},
          active: true,
        },
      });
      expect(result.name).toBe('New Provider');
      expect(result.active).toBe(true);
      expect(mockValidateWebhookUrl).not.toHaveBeenCalled();
    });

    it('rejects an invalid payout wallet address with BadRequestException', async () => {
      await expect(
        service.create({ name: 'Bad Payout', payoutWalletAddress: 'not-a-valid-address' }, WALLET),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.provider.create).not.toHaveBeenCalled();
    });

    it('rejects a payout wallet equal to the auth wallet by default', async () => {
      await expect(
        service.create({ name: 'Same Wallet', payoutWalletAddress: WALLET }, WALLET),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.provider.create).not.toHaveBeenCalled();
    });

    it('allows payout wallet equal to auth wallet when allowPayoutEqualsAuthWallet is true', async () => {
      mockConfig.security.allowPayoutEqualsAuthWallet = true;
      const mockCreated = makeProvider({ id: 'new-id', name: 'Same Wallet' });
      (mockPrisma.provider.create as jest.Mock).mockResolvedValue(mockCreated);

      const result = await service.create({ name: 'Same Wallet', payoutWalletAddress: WALLET }, WALLET);

      expect(result.name).toBe('Same Wallet');
      expect(mockPrisma.provider.create).toHaveBeenCalled();
    });

    it('creates an inactive provider when providerApprovalRequired is true', async () => {
      mockConfig.security.providerApprovalRequired = true;
      const mockCreated = makeProvider({ id: 'new-id', name: 'Pending', active: false });
      (mockPrisma.provider.create as jest.Mock).mockResolvedValue(mockCreated);

      const result = await service.create({ name: 'Pending' }, WALLET);

      expect(mockPrisma.provider.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ active: false }),
        }),
      );
      expect(result.active).toBe(false);
    });

    it('persists webhook configuration after SSRF validation', async () => {
      const mockCreated = makeProvider({ id: 'new-id', name: 'Webhook Provider' });
      (mockPrisma.provider.create as jest.Mock).mockResolvedValue(mockCreated);

      await service.create(
        {
          name: 'Webhook Provider',
          webhookUrl: 'https://hooks.example.com/x402',
          webhookSecret: '0123456789abcdef0123456789abcdef',
        },
        WALLET,
      );

      expect(mockValidateWebhookUrl).toHaveBeenCalledWith('https://hooks.example.com/x402');
      expect(mockPrisma.provider.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            webhookUrl: 'https://hooks.example.com/x402',
            webhookSecret: '0123456789abcdef0123456789abcdef',
          }),
        }),
      );
    });

    it('stores null and skips validation when webhookUrl is empty (not configured)', async () => {
      const mockCreated = makeProvider({ id: 'new-id', name: 'No Webhook' });
      (mockPrisma.provider.create as jest.Mock).mockResolvedValue(mockCreated);

      await service.create({ name: 'No Webhook', webhookUrl: '' }, WALLET);

      expect(mockValidateWebhookUrl).not.toHaveBeenCalled();
      expect(mockPrisma.provider.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ webhookUrl: null }) }),
      );
    });

    it('rejects an SSRF-target webhook URL with BadRequestException', async () => {
      mockValidateWebhookUrl.mockRejectedValue(
        new Error('Webhook URL must point to a public IP address'),
      );

      await expect(
        service.create(
          { name: 'Evil Provider', webhookUrl: 'https://169.254.169.254/latest/meta-data' },
          WALLET,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.provider.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates a provider owned by the wallet', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(makeProvider());
      (mockPrisma.provider.update as jest.Mock).mockResolvedValue(
        makeProvider({ name: 'Updated Name', active: false }),
      );

      const result = await service.update('p-1', { name: 'Updated Name', active: false }, WALLET);

      expect(mockPrisma.provider.findFirst).toHaveBeenCalledWith({
        where: { id: 'p-1', walletAddress: WALLET },
      });
      expect(result.name).toBe('Updated Name');
      expect(result.active).toBe(false);
      expect(mockValidateWebhookUrl).not.toHaveBeenCalled();
    });

    it('validates a new payout wallet address before persisting on update', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(makeProvider());
      (mockPrisma.provider.update as jest.Mock).mockResolvedValue(makeProvider());

      await service.update('p-1', { payoutWalletAddress: PAYOUT_WALLET }, WALLET);

      expect(mockPrisma.provider.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ payoutWalletAddress: PAYOUT_WALLET }),
        }),
      );
    });

    it('rejects an invalid payout wallet on update', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(makeProvider());

      await expect(
        service.update('p-1', { payoutWalletAddress: 'bad-address' }, WALLET),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.provider.update).not.toHaveBeenCalled();
    });

    it('rejects a payout wallet equal to the auth wallet on update by default', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(makeProvider());

      await expect(
        service.update('p-1', { payoutWalletAddress: WALLET }, WALLET),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.provider.update).not.toHaveBeenCalled();
    });

    it('validates a new webhook URL before persisting', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(makeProvider());
      (mockPrisma.provider.update as jest.Mock).mockResolvedValue(makeProvider());

      await service.update('p-1', { webhookUrl: 'https://hooks.example.com/x402' }, WALLET);

      expect(mockValidateWebhookUrl).toHaveBeenCalledWith('https://hooks.example.com/x402');
      expect(mockPrisma.provider.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ webhookUrl: 'https://hooks.example.com/x402' }),
        }),
      );
    });

    it('clears the webhook URL when an empty string is sent', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(makeProvider());
      (mockPrisma.provider.update as jest.Mock).mockResolvedValue(makeProvider());

      await service.update('p-1', { webhookUrl: '' }, WALLET);

      expect(mockValidateWebhookUrl).not.toHaveBeenCalled();
      expect(mockPrisma.provider.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ webhookUrl: null }) }),
      );
    });

    it('rejects an SSRF-target webhook URL on update with BadRequestException', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(makeProvider());
      mockValidateWebhookUrl.mockRejectedValue(
        new Error('Webhook URL must point to a public IP address'),
      );

      await expect(
        service.update('p-1', { webhookUrl: 'https://192.168.1.1/hook' }, WALLET),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.provider.update).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when updating another wallet's provider", async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.update('p-other', { name: 'hacked' }, OTHER_WALLET)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.provider.update).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('sets a provider active=true on approval', async () => {
      const pending = makeProvider({ id: 'pending-1', active: false });
      const approved = makeProvider({ id: 'pending-1', active: true });
      (mockPrisma.provider.findUnique as jest.Mock).mockResolvedValue(pending);
      (mockPrisma.provider.update as jest.Mock).mockResolvedValue(approved);

      const result = await service.approve('pending-1');

      expect(mockPrisma.provider.findUnique).toHaveBeenCalledWith({ where: { id: 'pending-1' } });
      expect(mockPrisma.provider.update).toHaveBeenCalledWith({
        where: { id: 'pending-1' },
        data: { active: true },
      });
      expect(result.active).toBe(true);
    });

    it('throws NotFoundException when approving a missing provider', async () => {
      (mockPrisma.provider.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.approve('missing')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.provider.update).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes a provider owned by the wallet', async () => {
      (mockPrisma.provider.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await expect(service.delete('p-1', WALLET)).resolves.toBeUndefined();
      expect(mockPrisma.provider.deleteMany).toHaveBeenCalledWith({
        where: { id: 'p-1', walletAddress: WALLET },
      });
    });

    it("throws NotFoundException when deleting another wallet's provider", async () => {
      (mockPrisma.provider.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.delete('p-other', OTHER_WALLET)).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByWalletAddress', () => {
    it('finds provider by wallet address', async () => {
      (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(makeProvider());

      const result = await service.findByWalletAddress(WALLET);

      expect(result?.walletAddress).toBe(WALLET);
    });
  });
});