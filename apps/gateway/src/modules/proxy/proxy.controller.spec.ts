import { ProxyController } from './proxy.controller';
import { loadConfig, setConfig } from '@x402/config';
import { logger } from '@x402/logger';
import { settleEscrow } from '../x402/escrow-client';
import type { PaymentRecord, RouteConfig } from '@x402/types';
import type { Response } from 'express';

// Escrow settlement is fire-and-forget by design (it must never block the
// LLM response), so the spec stubs it and asserts on the arguments instead
// of talking to a Soroban RPC. The stub resolves like the real async
// settleEscrow, which the controller chains `.catch()` onto.
jest.mock('../x402/escrow-client', () => ({
  settleEscrow: jest.fn().mockResolvedValue(undefined),
}));

const mockSettleEscrow = settleEscrow as jest.Mock;

const baseConfig = loadConfig();

// ── Fixtures ─────────────────────────────────

const perTokenRoute: RouteConfig = {
  id: 'route-token',
  providerId: 'prov-1',
  path: '/v1/chat/completions',
  upstreamUrl: 'https://api.example.com/v1/chat/completions',
  model: 'gpt-4',
  pricingModel: 'per_token',
  perTokenPrice: '10', // stroops per token
  acceptedAssets: ['USDC'],
  rateLimit: 10,
  active: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const flatRoute: RouteConfig = {
  ...perTokenRoute,
  id: 'route-flat',
  pricingModel: 'flat',
  flatPrice: '500',
};

const payment: PaymentRecord = {
  id: 'pay-1',
  quoteId: 'quote-1',
  txHash: 'a1b2c3',
  payerAddress: 'GA7QNFARKGM6Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q',
  amount: 1000000n, // 1 USDC in stroops
  asset: 'USDC',
  status: 'verified',
  verifiedAt: new Date(),
  receiptJson: null,
  routeId: 'route-token',
  providerId: 'prov-1',
  ledger: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function mockResponse(): Response {
  return {
    headersSent: false,
    setHeader: jest.fn(),
  } as unknown as Response;
}

function buildController(): ProxyController {
  return new ProxyController(
    {} as unknown as ConstructorParameters<typeof ProxyController>[0],
    {} as unknown as ConstructorParameters<typeof ProxyController>[1],
    {} as unknown as ConstructorParameters<typeof ProxyController>[2],
    {
      recordActualCost: jest.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof ProxyController>[3],
    {} as unknown as ConstructorParameters<typeof ProxyController>[4],
    {} as unknown as ConstructorParameters<typeof ProxyController>[5],
    {} as unknown as ConstructorParameters<typeof ProxyController>[6],
  );
}

// applyMeteredPricing is private; it is exercised through the controller's
// two call sites (streaming callback and non-streaming forward). Calling it
// directly keeps this spec focused on pricing + settlement semantics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callApplyMeteredPricing(
  controller: any,
  route: RouteConfig,
  pay: PaymentRecord | null,
  tokensUsed?: number,
) {
  const res = mockResponse();
  return {
    res,
    result: controller.applyMeteredPricing(route, pay, tokensUsed, res, 'trace-1'),
  };
}

describe('ProxyController.applyMeteredPricing', () => {
  afterEach(() => {
    setConfig(baseConfig);
    mockSettleEscrow.mockClear(); // keeps the resolved-value implementation
    jest.restoreAllMocks();
  });

  describe('flat-rate routes', () => {
    it('returns the paid amount and never touches escrow settlement', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const controller = buildController() as any;
      const flatPayment: PaymentRecord = { ...payment, amount: 500n };
      const { res, result } = callApplyMeteredPricing(controller, flatRoute, flatPayment);

      const out = await result;
      expect(out).toEqual({
        actualCost: '500',
        surplus: '0',
        isOverpaid: false,
        isUnderpaid: false,
      });
      expect(res.setHeader).toHaveBeenCalledWith('X-Actual-Cost', '500');
      expect(mockSettleEscrow).not.toHaveBeenCalled();
      expect(controller.paymentsService.recordActualCost).not.toHaveBeenCalled();
    });
  });

  describe('per-token routes', () => {
    it('charges actual cost and settles escrow when settlement is enabled', async () => {
      setConfig({
        ...baseConfig,
        payment: {
          ...baseConfig.payment,
          escrowSettlementEnabled: true,
          contractAdminSecret: 'SCONTRACTADMINSECRET123456789012345678901234567890',
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const controller = buildController() as any;
      const recordActualCost = controller.paymentsService.recordActualCost;

      const { res, result } = callApplyMeteredPricing(controller, perTokenRoute, payment, 1000);
      const out = await result;

      // 1000 tokens × 10 stroops = 10000 stroops actual cost; paid 1000000.
      expect(out).toEqual({
        actualCost: '10000',
        surplus: '990000',
        isOverpaid: true,
        isUnderpaid: false,
      });
      expect(res.setHeader).toHaveBeenCalledWith('X-Actual-Cost', '10000');
      expect(res.setHeader).toHaveBeenCalledWith('X-Tokens-Used', '1000');
      expect(recordActualCost).toHaveBeenCalledWith('quote-1', '10000', 1000);
      expect(mockSettleEscrow).toHaveBeenCalledWith({
        enabled: true,
        contractId: baseConfig.contracts.creditEscrow,
        rpcUrl: baseConfig.stellar.sorobanRpcUrl,
        networkPassphrase: baseConfig.stellar.networkPassphrase,
        adminSecret: 'SCONTRACTADMINSECRET123456789012345678901234567890',
        user: payment.payerAddress,
        actualCost: '10000',
        surplus: '990000',
        isOverpaid: true,
        quoteId: 'quote-1',
      });
    });

    it('still records actual cost and calls settleEscrow (no-op) when settlement is disabled', async () => {
      // Default config: ESCROW_SETTLEMENT_ENABLED unset → disabled.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const controller = buildController() as any;

      const { result } = callApplyMeteredPricing(controller, perTokenRoute, payment, 1000);
      const out = await result;

      expect(out.actualCost).toBe('10000');
      expect(controller.paymentsService.recordActualCost).toHaveBeenCalledWith(
        'quote-1',
        '10000',
        1000,
      );
      // The gateway still hands the request to settleEscrow, which no-ops
      // internally when disabled — the LLM response is never blocked.
      expect(mockSettleEscrow).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, user: payment.payerAddress, quoteId: 'quote-1' }),
      );
    });

    it('logs a warning once per process when a per-token route runs without escrow settlement', async () => {
      // Fresh module registry so the warn-once flag starts false.
      jest.resetModules();
      const { logger: freshLogger } = await import('@x402/logger');
      const warnSpy = jest.spyOn(freshLogger, 'warn');
      const freshConfig = await import('@x402/config');
      freshConfig.setConfig(freshConfig.loadConfig()); // escrowSettlementEnabled=false (default)
      const { ProxyController: FreshController } = await import('./proxy.controller');
      const { settleEscrow: freshSettle } = (await import('../x402/escrow-client')) as unknown as {
        settleEscrow: jest.Mock;
      };
      const controller = new FreshController(
        {} as never,
        {} as never,
        {} as never,
        { recordActualCost: jest.fn().mockResolvedValue(undefined) } as never,
        {} as never,
        {} as never,
        {} as never,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any;

      await controller.applyMeteredPricing(perTokenRoute, payment, 1000, mockResponse(), 'trace-1');
      await controller.applyMeteredPricing(perTokenRoute, payment, 1000, mockResponse(), 'trace-1');

      const escrowWarnings = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes('credit-escrow settlement is disabled'),
      );
      // Warned exactly once despite two per-token requests.
      expect(escrowWarnings).toHaveLength(1);
      expect(String(escrowWarnings[0][0])).toContain('ESCROW_SETTLEMENT_ENABLED is not true');
      // Settlement still attempted (best-effort no-op when disabled).
      expect(freshSettle).toHaveBeenCalledTimes(2);
    });

    it('flags underpayment when the paid amount is below actual cost', async () => {
      setConfig({
        ...baseConfig,
        payment: {
          ...baseConfig.payment,
          escrowSettlementEnabled: true,
          contractAdminSecret: 'SCONTRACTADMINSECRET123456789012345678901234567890',
        },
      });
      const warnSpy = jest.spyOn(logger, 'warn');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const controller = buildController() as any;
      const underpaidPayment: PaymentRecord = { ...payment, amount: 500n };

      const { result } = callApplyMeteredPricing(controller, perTokenRoute, underpaidPayment, 1000);
      const out = await result;

      expect(out.isUnderpaid).toBe(true);
      expect(out.surplus).toBe('-9500');
      expect(warnSpy).toHaveBeenCalledWith('Per-token underpayment detected', expect.any(Object));
      expect(mockSettleEscrow).toHaveBeenCalledWith(
        expect.objectContaining({ actualCost: '10000', surplus: '-9500', isOverpaid: false }),
      );
    });

    it('falls back to the paid amount when no usage data is available (streaming without usage chunk)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const controller = buildController() as any;

      const { res, result } = callApplyMeteredPricing(controller, perTokenRoute, payment);
      const out = await result;

      expect(out).toEqual({
        actualCost: '1000000',
        surplus: '0',
        isOverpaid: false,
        isUnderpaid: false,
      });
      expect(res.setHeader).toHaveBeenCalledWith('X-Actual-Cost', '1000000');
      expect(mockSettleEscrow).not.toHaveBeenCalled();
      expect(controller.paymentsService.recordActualCost).not.toHaveBeenCalled();
    });
  });
});
