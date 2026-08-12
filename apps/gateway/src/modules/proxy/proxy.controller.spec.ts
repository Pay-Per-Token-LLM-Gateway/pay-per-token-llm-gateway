import { ProxyController } from './proxy.controller';
import { loadConfig, setConfig } from '@x402/config';
import { logger } from '@x402/logger';
import { settleEscrow } from '../x402/escrow-client';
import type { PaymentRecord, Quote, RouteConfig } from '@x402/types';
import type { Request, Response } from 'express';

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

// ── handleChatCompletion (request flow) ──────

interface FlowMocks {
  proxyService: { forwardRequest: jest.Mock; forwardStreamRequest: jest.Mock };
  x402Service: {
    generateQuoteForRoute: jest.Mock;
    build402Response: jest.Mock;
    verifyPayment: jest.Mock;
    isQuoteExpired: jest.Mock;
  };
  routesService: { findByPathAndModel: jest.Mock };
  paymentsService: {
    findByTxHash: jest.Mock;
    createPendingPayment: jest.Mock;
    confirmPayment: jest.Mock;
    recordActualCost: jest.Mock;
  };
  analyticsService: { recordUnpaidRequest: jest.Mock; recordPaidRequest: jest.Mock };
  adminService: { writeAuditLog: jest.Mock };
  webhooksService: { notifyVerificationFailed: jest.Mock; notifyPaymentReceived: jest.Mock };
  res: jest.Mocked<Response> & { status: jest.Mock; json: jest.Mock; write: jest.Mock };
}

function buildFlowHarness(): { controller: ProxyController; mocks: FlowMocks } {
  const mocks: FlowMocks = {
    proxyService: { forwardRequest: jest.fn(), forwardStreamRequest: jest.fn() },
    x402Service: {
      generateQuoteForRoute: jest.fn(),
      build402Response: jest.fn(),
      verifyPayment: jest.fn(),
      isQuoteExpired: jest.fn(),
    },
    routesService: { findByPathAndModel: jest.fn() },
    paymentsService: {
      findByTxHash: jest.fn(),
      createPendingPayment: jest.fn().mockResolvedValue(undefined),
      confirmPayment: jest.fn(),
      recordActualCost: jest.fn().mockResolvedValue(undefined),
    },
    analyticsService: { recordUnpaidRequest: jest.fn(), recordPaidRequest: jest.fn() },
    adminService: { writeAuditLog: jest.fn().mockResolvedValue(undefined) },
    webhooksService: {
      notifyVerificationFailed: jest.fn().mockResolvedValue(undefined),
      notifyPaymentReceived: jest.fn().mockResolvedValue(undefined),
    },
    res: {} as FlowMocks['res'],
  };
  mocks.res.status = jest.fn().mockReturnValue(mocks.res);
  mocks.res.json = jest.fn().mockReturnValue(mocks.res);
  mocks.res.write = jest.fn();
  mocks.res.headersSent = false;
  mocks.res.setHeader = jest.fn();

  const controller = new ProxyController(
    mocks.proxyService as never,
    mocks.x402Service as never,
    mocks.routesService as never,
    mocks.paymentsService as never,
    mocks.analyticsService as never,
    mocks.adminService as never,
    mocks.webhooksService as never,
  );
  return { controller, mocks };
}

function flowReq(overrides: Partial<Record<string, unknown>> = {}): Request {
  return {
    body: { model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] },
    path: '/v1/chat/completions',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

const VALID_TX_HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

const verificationQuote: Quote = {
  id: 'quote-1',
  route: '/v1/chat/completions',
  pricingModel: 'flat',
  amount: '500',
  asset: 'USDC',
  paymentAddress: 'GA7QNFARKGM6Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q3Q7Q',
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  network: 'testnet',
  statusUrl: 'https://gateway.local/payments/quote-1',
};

describe('ProxyController.handleChatCompletion', () => {
  afterEach(() => {
    setConfig(baseConfig);
    jest.clearAllMocks();
  });

  it('returns 400 for an invalid request body', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(flatRoute);

    await controller.handleChatCompletion(
      flowReq({ body: { model: 'gpt-4' } }), // missing messages
      mocks.res,
    );

    expect(mocks.res.status).toHaveBeenCalledWith(400);
    expect(mocks.res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it('returns 404 when no route matches the requested model', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(null);

    await controller.handleChatCompletion(flowReq(), mocks.res);

    expect(mocks.res.status).toHaveBeenCalledWith(404);
    expect(mocks.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('No route configured') }),
    );
  });

  it('returns 402 with a generated quote when no payment hash is present', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(flatRoute);
    mocks.x402Service.generateQuoteForRoute.mockResolvedValue(verificationQuote);
    mocks.x402Service.build402Response.mockResolvedValue({
      status: 402,
      payment: verificationQuote,
    });

    await controller.handleChatCompletion(flowReq(), mocks.res);

    expect(mocks.res.status).toHaveBeenCalledWith(402);
    expect(mocks.x402Service.generateQuoteForRoute).toHaveBeenCalledWith(flatRoute, undefined);
    expect(mocks.paymentsService.createPendingPayment).toHaveBeenCalledWith(
      verificationQuote,
      flatRoute,
    );
    expect(mocks.analyticsService.recordUnpaidRequest).toHaveBeenCalledWith(
      flatRoute.path,
      flatRoute.providerId,
    );
    expect(mocks.adminService.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'quote_generated' }),
    );
    expect(mocks.res.json).toHaveBeenCalledWith({ status: 402, payment: verificationQuote });
  });

  it('passes the estimated token count into the quote for per-token routes', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(perTokenRoute);
    mocks.x402Service.generateQuoteForRoute.mockResolvedValue(verificationQuote);
    mocks.x402Service.build402Response.mockResolvedValue({ status: 402 });

    await controller.handleChatCompletion(
      flowReq({
        body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
      }),
      mocks.res,
    );

    expect(mocks.x402Service.generateQuoteForRoute).toHaveBeenCalledWith(perTokenRoute, 100);
  });

  it('returns 400 for a malformed X-Payment-Hash header', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(flatRoute);

    await controller.handleChatCompletion(
      flowReq({ headers: { 'x-payment-hash': 'not-a-hex-string' } }),
      mocks.res,
    );

    expect(mocks.res.status).toHaveBeenCalledWith(400);
    expect(mocks.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Invalid X-Payment-Hash') }),
    );
  });

  it('rejects a confirmed payment replayed against a different route', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(flatRoute);
    mocks.paymentsService.findByTxHash.mockResolvedValue({
      status: 'confirmed',
      routeId: 'some-other-route',
    });

    await controller.handleChatCompletion(
      flowReq({ headers: { 'x-payment-hash': VALID_TX_HASH } }),
      mocks.res,
    );

    expect(mocks.res.status).toHaveBeenCalledWith(402);
    expect(mocks.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('different route') }),
    );
    expect(mocks.x402Service.verifyPayment).not.toHaveBeenCalled();
  });

  it('rejects a confirmed payment replayed on the same route', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(flatRoute);
    mocks.paymentsService.findByTxHash.mockResolvedValue({
      status: 'confirmed',
      routeId: flatRoute.id,
    });

    await controller.handleChatCompletion(
      flowReq({ headers: { 'x-payment-hash': VALID_TX_HASH } }),
      mocks.res,
    );

    expect(mocks.res.status).toHaveBeenCalledWith(402);
    expect(mocks.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('already been used') }),
    );
  });

  it('rejects a payment made with an expired stored quote', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(flatRoute);
    mocks.paymentsService.findByTxHash.mockResolvedValue({
      status: 'pending',
      routeId: flatRoute.id,
      receiptJson: verificationQuote,
    });
    mocks.x402Service.isQuoteExpired.mockReturnValue(true);

    await controller.handleChatCompletion(
      flowReq({ headers: { 'x-payment-hash': VALID_TX_HASH } }),
      mocks.res,
    );

    expect(mocks.res.status).toHaveBeenCalledWith(402);
    expect(mocks.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('quote has expired') }),
    );
  });

  it('returns 402 when payment verification fails and notifies the provider', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(flatRoute);
    mocks.paymentsService.findByTxHash.mockResolvedValue(null);
    mocks.x402Service.generateQuoteForRoute.mockResolvedValue(verificationQuote);
    mocks.x402Service.verifyPayment.mockResolvedValue({
      verified: false,
      txHash: VALID_TX_HASH,
      payerAddress: '',
      amount: '0',
      asset: 'USDC',
      ledger: 0,
      timestamp: 0,
      failureReason: 'Insufficient amount',
    });

    await controller.handleChatCompletion(
      flowReq({ headers: { 'x-payment-hash': VALID_TX_HASH } }),
      mocks.res,
    );

    expect(mocks.res.status).toHaveBeenCalledWith(402);
    expect(mocks.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Insufficient amount') }),
    );
    expect(mocks.adminService.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment_verification_failed' }),
    );
    expect(mocks.webhooksService.notifyVerificationFailed).toHaveBeenCalled();
  });

  it('forwards a non-streaming request and returns the upstream JSON with a receipt header', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(perTokenRoute);
    mocks.paymentsService.findByTxHash
      .mockResolvedValueOnce(null) // verify stage: no existing payment row
      .mockResolvedValueOnce(payment); // forward stage: payment confirmed
    mocks.x402Service.generateQuoteForRoute.mockResolvedValue(verificationQuote);
    mocks.x402Service.verifyPayment.mockResolvedValue({
      verified: true,
      txHash: VALID_TX_HASH,
      payerAddress: payment.payerAddress,
      amount: '1000000',
      asset: 'USDC',
      ledger: 10,
      timestamp: 1700000000,
      failureReason: '',
    });
    mocks.paymentsService.confirmPayment.mockResolvedValue(payment);
    mocks.proxyService.forwardRequest.mockResolvedValue({
      response: { id: 'cmpl-1', usage: { total_tokens: 1000 } },
      responseTime: 42,
    });

    await controller.handleChatCompletion(
      flowReq({ headers: { 'x-payment-hash': VALID_TX_HASH } }),
      mocks.res,
    );

    expect(mocks.res.json).toHaveBeenCalledWith({ id: 'cmpl-1', usage: { total_tokens: 1000 } });
    expect(mocks.res.setHeader).toHaveBeenCalledWith(
      'X-Payment-Receipt',
      expect.stringContaining('quote-1'),
    );
    expect(mocks.res.setHeader).toHaveBeenCalledWith('X-Request-Trace-Id', expect.any(String));
    expect(mocks.analyticsService.recordPaidRequest).toHaveBeenCalledWith(
      perTokenRoute.path,
      perTokenRoute.providerId,
      payment.payerAddress,
      '10000', // 1000 tokens × 10 stroops
      'USDC',
      42,
    );
    expect(mocks.adminService.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'request_forwarded' }),
    );
    expect(mocks.webhooksService.notifyPaymentReceived).toHaveBeenCalled();
  });

  it('forwards a streaming request and emits a trailing receipt event', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(perTokenRoute);
    mocks.paymentsService.findByTxHash.mockResolvedValueOnce(null).mockResolvedValueOnce(payment);
    mocks.x402Service.generateQuoteForRoute.mockResolvedValue(verificationQuote);
    mocks.x402Service.verifyPayment.mockResolvedValue({
      verified: true,
      txHash: VALID_TX_HASH,
      payerAddress: payment.payerAddress,
      amount: '1000000',
      asset: 'USDC',
      ledger: 10,
      timestamp: 1700000000,
      failureReason: '',
    });
    mocks.paymentsService.confirmPayment.mockResolvedValue(payment);

    let onDone: ((totalTokens?: number) => void | Promise<void>) | undefined;
    mocks.proxyService.forwardStreamRequest.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (_body: any, _url: any, _res: any, _apiKey: any, _traceId: any, cb: any) => {
        onDone = cb;
      },
    );

    await controller.handleChatCompletion(
      flowReq({
        body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true },
        headers: { 'x-payment-hash': VALID_TX_HASH },
      }),
      mocks.res,
    );

    expect(mocks.proxyService.forwardStreamRequest).toHaveBeenCalledTimes(1);
    expect(mocks.adminService.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'request_forwarded_stream' }),
    );

    // Simulate stream completion with a usage chunk → trailing receipt event.
    await onDone?.(1000);

    expect(mocks.res.write).toHaveBeenCalledWith(expect.stringContaining('x402_receipt'));
    expect(mocks.res.write).toHaveBeenCalledWith('data: [DONE]\n\n');
    expect(mocks.analyticsService.recordPaidRequest).toHaveBeenCalledWith(
      perTokenRoute.path,
      perTokenRoute.providerId,
      payment.payerAddress,
      '10000',
      'USDC',
      expect.any(Number),
    );
  });

  it('returns 402 when the payment claim is lost to a concurrent request', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockResolvedValue(flatRoute);
    mocks.paymentsService.findByTxHash.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mocks.x402Service.generateQuoteForRoute.mockResolvedValue(verificationQuote);
    mocks.x402Service.verifyPayment.mockResolvedValue({
      verified: true,
      txHash: VALID_TX_HASH,
      payerAddress: 'GA7Q...',
      amount: '500',
      asset: 'USDC',
      ledger: 10,
      timestamp: 1700000000,
      failureReason: '',
    });
    mocks.paymentsService.confirmPayment.mockResolvedValue(null); // lost the race

    await controller.handleChatCompletion(
      flowReq({ headers: { 'x-payment-hash': VALID_TX_HASH } }),
      mocks.res,
    );

    expect(mocks.res.status).toHaveBeenCalledWith(402);
    expect(mocks.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('already been used') }),
    );
  });

  it('returns 502 when an unexpected error occurs', async () => {
    const { controller, mocks } = buildFlowHarness();
    mocks.routesService.findByPathAndModel.mockRejectedValue(new Error('db down'));

    await controller.handleChatCompletion(flowReq(), mocks.res);

    expect(mocks.res.status).toHaveBeenCalledWith(502);
    expect(mocks.res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 502 }));
  });
});
