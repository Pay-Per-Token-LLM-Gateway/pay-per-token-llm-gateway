/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';

jest.mock('@x402/database', () => ({
  prisma: {
    provider: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    route: {
      count: jest.fn(),
    },
    payment: {
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    payoutProposal: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      aggregate: jest.fn(),
    },
  },
}));

const mockPrisma = jest.requireMock('@x402/database').prisma as any;

const OWNER = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';

describe('AdminService', () => {
  let service: AdminService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminService();
  });

  describe('getAuditLogs', () => {
    it("scopes audit reads to the owner's providers", async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([
        { id: 'provider-1' },
        { id: 'provider-2' },
      ]);
      (mockPrisma.auditLog.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.auditLog.count as jest.Mock).mockResolvedValue(0);

      const result = await service.getAuditLogs(OWNER, { page: 1, limit: 20 });

      expect(mockPrisma.provider.findMany).toHaveBeenCalledWith({
        where: { walletAddress: OWNER },
        select: { id: true },
      });
      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { providerId: { in: ['provider-1', 'provider-2'] } },
          skip: 0,
          take: 20,
        }),
      );
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });

    it('applies action/entity filters alongside provider scoping', async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([{ id: 'provider-1' }]);
      (mockPrisma.auditLog.findMany as jest.Mock).mockResolvedValue([{ id: 'log-1' }]);
      (mockPrisma.auditLog.count as jest.Mock).mockResolvedValue(1);

      const result = await service.getAuditLogs(OWNER, {
        action: 'payment_verified',
        entity: 'payment',
        page: 2,
        limit: 10,
      });

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            providerId: { in: ['provider-1'] },
            action: 'payment_verified',
            entity: 'payment',
          },
          skip: 10,
          take: 10,
        }),
      );
      expect(result.totalPages).toBe(1);
    });

    it('filters by an owned providerId', async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([{ id: 'provider-1' }]);
      (mockPrisma.auditLog.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.auditLog.count as jest.Mock).mockResolvedValue(0);

      await service.getAuditLogs(OWNER, { providerId: 'provider-1' });

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { providerId: 'provider-1' } }),
      );
    });

    it("throws NotFoundException for another wallet's provider", async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([{ id: 'provider-1' }]);

      await expect(service.getAuditLogs(OWNER, { providerId: 'provider-other' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.count).not.toHaveBeenCalled();
    });
  });

  describe('getStats (wallet-scoped)', () => {
    it("scopes statistics to the authenticated wallet's providers", async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([
        { id: 'provider-1' },
        { id: 'provider-2' },
      ]);
      (mockPrisma.provider.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.route.count as jest.Mock).mockResolvedValue(3);
      (mockPrisma.payment.count as jest.Mock)
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(7); // confirmed

      const stats = await service.getStats(OWNER);

      expect(mockPrisma.provider.findMany).toHaveBeenCalledWith({
        where: { walletAddress: OWNER },
        select: { id: true },
      });
      expect(mockPrisma.route.count).toHaveBeenCalledWith({
        where: { providerId: { in: ['provider-1', 'provider-2'] } },
      });
      expect(stats.providers).toBe(2);
      expect(stats.routes).toBe(3);
      expect(stats.totalPayments).toBe(10);
      expect(stats.confirmedPayments).toBe(7);
      expect(stats.failedPayments).toBe(3);
    });
  });

  describe('expireStalePayments', () => {
    it('expires pending payments older than the quote window', async () => {
      (mockPrisma.payment.updateMany as jest.Mock).mockResolvedValue({ count: 5 });

      const count = await service.expireStalePayments(300);

      expect(count).toBe(5);
      const call = (mockPrisma.payment.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.data).toEqual({ status: 'expired' });
      expect(call.where.status).toBe('pending');
      expect(call.where.createdAt.lt).toBeInstanceOf(Date);
    });
  });

  describe('writeAuditLog', () => {
    it('persists providerId on the audit entry', async () => {
      (mockPrisma.auditLog.create as jest.Mock).mockResolvedValue({ id: 'log-1' });

      await service.writeAuditLog({
        action: 'quote_generated',
        entity: 'quote',
        entityId: 'quote-1',
        providerId: 'provider-1',
        actor: 'system',
        details: { route: '/v1/chat/completions' },
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          action: 'quote_generated',
          entity: 'quote',
          entityId: 'quote-1',
          providerId: 'provider-1',
          actor: 'system',
          details: { route: '/v1/chat/completions' },
        },
      });
    });
  });

  // ── Payout Tests ─────────────────────────────

  describe('proposePayout', () => {
    it('rejects when payout automation is disabled', async () => {
      jest.spyOn(require('@x402/config'), 'getConfig').mockReturnValue({
        payment: { payoutAutomationEnabled: false, contractAdminSecret: 'secret' },
      });

      await expect(service.proposePayout('provider-1', OWNER)).rejects.toThrow(
        'Payout automation is not enabled',
      );
    });

    it('rejects when CONTRACT_ADMIN_SECRET is missing', async () => {
      jest.spyOn(require('@x402/config'), 'getConfig').mockReturnValue({
        payment: { payoutAutomationEnabled: true, contractAdminSecret: undefined },
      });

      await expect(service.proposePayout('provider-1', OWNER)).rejects.toThrow(
        'CONTRACT_ADMIN_SECRET is required for payouts',
      );
    });
  });

  describe('approvePayoutProposal', () => {
    it('rejects when payout automation is disabled', async () => {
      jest.spyOn(require('@x402/config'), 'getConfig').mockReturnValue({
        payment: { payoutAutomationEnabled: false, contractAdminSecret: 'secret' },
      });

      await expect(service.approvePayoutProposal('proposal-1', OWNER)).rejects.toThrow(
        'Payout automation is not enabled',
      );
    });
  });

  describe('getPayoutProposals', () => {
    it('returns an empty list when no proposals exist', async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([{ id: 'provider-1' }]);
      mockPrisma.payoutProposal.findMany.mockResolvedValue([]);
      mockPrisma.payoutProposal.count.mockResolvedValue(0);

      const result = await service.getPayoutProposals(OWNER, { page: 1, limit: 10 });

      expect(mockPrisma.provider.findMany).toHaveBeenCalledWith({
        where: { walletAddress: OWNER },
        select: { id: true },
      });
      expect(mockPrisma.payoutProposal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { providerId: { in: ['provider-1'] } },
          skip: 0,
          take: 10,
        }),
      );
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });
  });
});
