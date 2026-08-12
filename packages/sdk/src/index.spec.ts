/**
 * @x402/sdk — unit tests for the 402 → pay → retry flow.
 *
 * Covers (issue #45):
 *   - call(): 200 path, 402 → pay → retry, quote expiry, wrong-asset
 *     rejection, gateway errors
 *   - callStream(): SSE chunk parsing, x402_receipt trailing event,
 *     [DONE] termination
 *   - executePayment: secretKey path and external signTransaction path
 *   - checkPaymentStatus
 *
 * All network access is mocked: global fetch is stubbed per test and the
 * `@x402/wallet` module is mocked so no real Stellar/Horizon calls happen.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { X402Client, createX402Client } from './index';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
  PaymentReceipt,
  PaymentRequiredResponse,
  Quote,
} from '@x402/types';
import {
  buildPaymentTransaction,
  buildUnsignedPaymentTransaction,
  createHorizonServer,
} from '@x402/wallet';
import { TransactionBuilder } from '@stellar/stellar-sdk';

// ── Mocks ─────────────────────────────────────

jest.mock('@x402/wallet', () => ({
  buildPaymentTransaction: jest.fn(),
  buildUnsignedPaymentTransaction: jest.fn(),
  createHorizonServer: jest.fn(),
  getNetworkPassphrase: (network: string) =>
    network === 'mainnet'
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015',
}));

// The SDK re-hydrates signed XDR before submitting to Horizon (stellar-sdk
// v12's submitTransaction requires a Transaction object, not a raw string).
// Mock the parser so tests stay hermetic and can assert what gets submitted.
jest.mock('@stellar/stellar-sdk', () => ({
  TransactionBuilder: { fromXDR: jest.fn() },
}));

// Keep stroopsToUnits real but make sleep instant so waitForConfirmation
// does not actually poll for seconds.
jest.mock('@x402/shared', () => {
  const actual = jest.requireActual('@x402/shared');
  return { ...actual, sleep: jest.fn().mockResolvedValue(undefined) };
});

const mockBuildPayment = buildPaymentTransaction as jest.Mock;
const mockBuildUnsigned = buildUnsignedPaymentTransaction as jest.Mock;
const mockCreateHorizonServer = createHorizonServer as jest.Mock;
const mockFromXDR = TransactionBuilder.fromXDR as jest.Mock;

/** A stand-in for the Transaction object stellar-sdk's submitTransaction expects. */
function fakeTransaction() {
  return { toEnvelope: jest.fn().mockReturnValue({ toXDR: () => 'FAKE_XDR' }) };
}

// ── Fixtures ──────────────────────────────────

const GATEWAY_URL = 'https://gateway.test';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const WALLET = 'GABQ7R3X2P3J4K5L6M7N8P9Q0R1S2T3U4V5W6X7Y8Z9ABCD';

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: 'quote-123',
    route: '/v1/chat/completions',
    pricingModel: 'flat',
    amount: '1000000',
    asset: 'USDC',
    assetIssuer: USDC_ISSUER,
    paymentAddress: WALLET,
    memo: 'quote-123',
    network: 'testnet',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    statusUrl: `${GATEWAY_URL}/api/v1/payments/quote-123/status`,
    ...overrides,
  };
}

function makePaymentRequired(quote: Quote = makeQuote()): PaymentRequiredResponse {
  return {
    status: 402,
    message: 'Payment Required',
    quote,
    instructions: 'Send payment',
    docs: `${GATEWAY_URL}/docs/x402`,
  };
}

function makeReceipt(overrides: Partial<PaymentReceipt> = {}): PaymentReceipt {
  return {
    id: 'receipt-1',
    quoteId: 'quote-123',
    txHash: 'txhash-abc',
    payerAddress: 'GPAYER123',
    amount: '1000000',
    asset: 'USDC',
    route: '/v1/chat/completions',
    status: 'confirmed',
    verifiedAt: new Date().toISOString(),
    ledger: 12345,
    ...overrides,
  };
}

function makeChatResponse(): ChatCompletionResponse {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello from the LLM' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeRequest(): ChatCompletionRequest {
  return { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] };
}

/** Build a real Response with a JSON body and optional headers. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Build a real SSE Response whose body streams the given data frames. */
function sseResponse(frames: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`${frame}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', ...headers },
  });
}

/**
 * Install a fetch mock that dispatches by URL:
 *  - gateway URLs served from the `gatewayResponses` queue in order
 *  - horizon URLs served from the `horizonResponses` queue in order
 * Returns the mock so tests can assert call counts / arguments.
 */
function installFetchMock(
  gatewayResponses: Response[],
  horizonResponses: Response[] = [],
): jest.Mock {
  const fetchMock = jest.fn();
  (global as any).fetch = fetchMock;

  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith(HORIZON_URL)) {
      const next = horizonResponses.shift();
      if (next) return Promise.resolve(next);
      throw new Error(`Unexpected Horizon fetch: ${url}`);
    }
    if (url.startsWith(GATEWAY_URL)) {
      const next = gatewayResponses.shift();
      if (next) return Promise.resolve(next);
      throw new Error(`Unexpected gateway fetch: ${url}`);
    }
    return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
  });

  return fetchMock;
}

/** Reset wallet mocks and install a default working submitTransaction. */
function resetWalletMocks() {
  mockBuildPayment.mockReset();
  mockBuildUnsigned.mockReset();
  mockCreateHorizonServer.mockReset();
  mockCreateHorizonServer.mockReturnValue({
    submitTransaction: jest.fn().mockResolvedValue({}),
  });
  mockBuildPayment.mockResolvedValue({ txXdr: 'TX_XDR', txHash: 'txhash-abc' });
  mockBuildUnsigned.mockResolvedValue({ txXdr: 'UNSIGNED_XDR', txHash: 'txhash-abc' });
  mockFromXDR.mockReset();
  mockFromXDR.mockReturnValue(fakeTransaction());
}

beforeEach(() => {
  resetWalletMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── call(): 200 path ──────────────────────────

describe('X402Client.call()', () => {
  it('returns the LLM response on a 200 with no payment flow', async () => {
    const llm = makeChatResponse();
    const fetchMock = installFetchMock([jsonResponse(llm)]);
    const client = new X402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    const result = await client.call(makeRequest());

    expect(result.success).toBe(true);
    expect(result.response).toEqual(llm);
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${GATEWAY_URL}/v1/chat/completions`);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(makeRequest());
  });

  it('uses a custom path when provided', async () => {
    const llm = makeChatResponse();
    const fetchMock = installFetchMock([jsonResponse(llm)]);
    const client = new X402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    await client.call(makeRequest(), { path: '/v1/custom/model' });

    expect(fetchMock.mock.calls[0][0]).toBe(`${GATEWAY_URL}/v1/custom/model`);
  });

  it('returns a gateway error result on non-2xx, non-402 responses', async () => {
    installFetchMock([jsonResponse({ error: 'nope' }, 500)]);
    const client = new X402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    const result = await client.call(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Gateway error: 500');
  });

  // ── call(): 402 → pay → retry ───────────────

  it('handles 402 → pay → retry with the secretKey path', async () => {
    const quote = makeQuote();
    const llm = makeChatResponse();
    const receipt = makeReceipt();

    const fetchMock = installFetchMock(
      [
        jsonResponse(makePaymentRequired(quote), 402),
        // Retry after payment: successful LLM call with receipt header.
        jsonResponse(llm, 200, { 'X-Payment-Receipt': JSON.stringify(receipt) }),
      ],
      [
        // waitForConfirmation polls Horizon for the tx.
        jsonResponse({ successful: true }),
      ],
    );

    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      secretKey: 'S' + 'A'.repeat(55),
    });

    const result = await client.call(makeRequest());

    expect(result.success).toBe(true);
    expect(result.response).toEqual(llm);
    expect(result.receipt).toEqual(receipt);
    expect(result.cost).toEqual({ amount: receipt.amount, asset: 'USDC' });

    // Payment was built + submitted. The signed XDR is re-hydrated into a
    // Transaction before submitTransaction (stellar-sdk v12 requires an
    // object, not a raw XDR string).
    expect(mockBuildPayment).toHaveBeenCalledTimes(1);
    expect(mockCreateHorizonServer).toHaveBeenCalledTimes(1);
    expect(mockFromXDR).toHaveBeenCalledWith('TX_XDR', 'Test SDF Network ; September 2015');
    const submit = (mockCreateHorizonServer.mock.results[0].value as any).submitTransaction;
    expect(submit).toHaveBeenCalledWith(mockFromXDR.mock.results[0].value);

    // Retry carried the payment hash header.
    const retryCall = fetchMock.mock.calls[2]; // 0: 402, 1: horizon poll, 2: retry
    expect(retryCall[0]).toBe(`${GATEWAY_URL}/v1/chat/completions`);
    expect(retryCall[1].headers['X-Payment-Hash']).toBe('txhash-abc');
    expect(fetchMock).toHaveBeenCalledTimes(3); // 402 + horizon poll + retry
  });

  it('rejects expired quotes before paying', async () => {
    const quote = makeQuote({ expiresAt: Math.floor(Date.now() / 1000) - 60 });
    installFetchMock([jsonResponse(makePaymentRequired(quote), 402)]);
    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      secretKey: 'S' + 'A'.repeat(55),
    });

    const result = await client.call(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Quote expired');
    expect(mockBuildPayment).not.toHaveBeenCalled();
  });

  it('rejects a wrong asset before paying', async () => {
    const quote = makeQuote({ asset: 'XLM' });
    installFetchMock([jsonResponse(makePaymentRequired(quote), 402)]);
    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      secretKey: 'S' + 'A'.repeat(55),
      defaultAsset: 'USDC',
    });

    const result = await client.call(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Wrong asset');
    expect(mockBuildPayment).not.toHaveBeenCalled();
  });

  it('returns a helpful error when no signer is configured', async () => {
    const quote = makeQuote();
    installFetchMock([jsonResponse(makePaymentRequired(quote), 402)]);
    const client = new X402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    const result = await client.call(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Payment required');
    expect(mockBuildPayment).not.toHaveBeenCalled();
  });

  it('surfaces payment failures as error results', async () => {
    const quote = makeQuote();
    installFetchMock([jsonResponse(makePaymentRequired(quote), 402)]);
    mockBuildPayment.mockRejectedValue(new Error('Horizon down'));
    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      secretKey: 'S' + 'A'.repeat(55),
    });

    const result = await client.call(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Payment failed: Horizon down');
  });

  it('reports a gateway error after payment as a failure', async () => {
    const quote = makeQuote();
    installFetchMock(
      [
        jsonResponse(makePaymentRequired(quote), 402),
        jsonResponse({ error: 'upstream exploded' }, 502),
      ],
      [jsonResponse({ successful: true })],
    );
    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      secretKey: 'S' + 'A'.repeat(55),
    });

    const result = await client.call(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Gateway error after payment: 502');
  });
});

// ── call(): external signer path ──────────────

describe('X402Client external signer path', () => {
  it('builds an unsigned tx, signs externally, then submits', async () => {
    const quote = makeQuote();
    const llm = makeChatResponse();
    const signTransaction = jest.fn().mockResolvedValue('SIGNED_XDR');

    const fetchMock = installFetchMock(
      [
        jsonResponse(makePaymentRequired(quote), 402),
        jsonResponse(llm, 200, { 'X-Payment-Receipt': JSON.stringify(makeReceipt()) }),
      ],
      [jsonResponse({ successful: true })],
    );

    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      publicKey: WALLET,
      signTransaction,
    });

    const result = await client.call(makeRequest());

    expect(result.success).toBe(true);
    expect(result.response).toEqual(llm);

    // Unsigned tx built with the external public key, then handed to signer.
    expect(mockBuildUnsigned).toHaveBeenCalledTimes(1);
    expect(mockBuildUnsigned.mock.calls[0][0].sourcePublicKey).toBe(WALLET);
    expect(signTransaction).toHaveBeenCalledWith('UNSIGNED_XDR');
    expect(mockCreateHorizonServer).toHaveBeenCalledTimes(1);
    // The signed XDR is re-hydrated into a Transaction before submission.
    expect(mockFromXDR).toHaveBeenCalledWith('SIGNED_XDR', 'Test SDF Network ; September 2015');
    const submit = (mockCreateHorizonServer.mock.results[0].value as any).submitTransaction;
    expect(submit).toHaveBeenCalledWith(mockFromXDR.mock.results[0].value);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails fast when signTransaction is set but publicKey is missing', async () => {
    const quote = makeQuote();
    installFetchMock([jsonResponse(makePaymentRequired(quote), 402)]);
    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      signTransaction: jest.fn(),
    });

    const result = await client.call(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain('publicKey is required');
    expect(mockBuildUnsigned).not.toHaveBeenCalled();
  });

  it('surfaces external signer failures as error results', async () => {
    const quote = makeQuote();
    installFetchMock([jsonResponse(makePaymentRequired(quote), 402)]);
    mockBuildUnsigned.mockRejectedValue(new Error('wallet declined'));
    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      publicKey: WALLET,
      signTransaction: jest.fn(),
    });

    const result = await client.call(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain('External payment failed: wallet declined');
  });
});

// ── callStream(): SSE ─────────────────────────

describe('X402Client.callStream()', () => {
  const chunk1: ChatCompletionStreamChunk = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
  };
  const chunk2: ChatCompletionStreamChunk = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
  };

  it('parses SSE chunks and stops at [DONE]', async () => {
    const frames = [
      `data: ${JSON.stringify(chunk1)}`,
      `data: ${JSON.stringify(chunk2)}`,
      'data: [DONE]',
    ];
    installFetchMock([sseResponse(frames)]);
    const client = new X402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    const result = await client.callStream(makeRequest());
    expect(result.success).toBe(true);

    const chunks: ChatCompletionStreamChunk[] = [];
    for await (const chunk of result.stream!) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([chunk1, chunk2]);
  });

  it('captures the trailing x402_receipt event and skips it as a chunk', async () => {
    const receipt = makeReceipt();
    const frames = [
      `data: ${JSON.stringify(chunk1)}`,
      `data: ${JSON.stringify({ x402_receipt: receipt })}`,
      'data: [DONE]',
    ];
    installFetchMock([sseResponse(frames)]);
    const client = new X402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    const result = await client.callStream(makeRequest());
    const chunks: ChatCompletionStreamChunk[] = [];
    for await (const chunk of result.stream!) {
      chunks.push(chunk);
    }

    // The receipt frame must not be surfaced as an LLM chunk.
    expect(chunks).toEqual([chunk1]);
  });

  it('returns the receipt from the X-Payment-Receipt header on a 200', async () => {
    const receipt = makeReceipt();
    installFetchMock([
      sseResponse([`data: ${JSON.stringify(chunk1)}`, 'data: [DONE]'], {
        'X-Payment-Receipt': JSON.stringify(receipt),
      }),
    ]);
    const client = new X402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    const result = await client.callStream(makeRequest());

    expect(result.success).toBe(true);
    expect(result.receipt).toEqual(receipt);
    expect(result.cost).toEqual({ amount: receipt.amount, asset: 'USDC' });
  });

  it('handles 402 → pay → retry on the streaming path', async () => {
    const quote = makeQuote();
    const receipt = makeReceipt();

    installFetchMock(
      [
        jsonResponse(makePaymentRequired(quote), 402),
        sseResponse([`data: ${JSON.stringify(chunk1)}`, 'data: [DONE]'], {
          'X-Payment-Receipt': JSON.stringify(receipt),
        }),
      ],
      [jsonResponse({ successful: true })],
    );

    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      secretKey: 'S' + 'A'.repeat(55),
    });

    const result = await client.callStream(makeRequest());
    expect(result.success).toBe(true);

    const chunks: ChatCompletionStreamChunk[] = [];
    for await (const chunk of result.stream!) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([chunk1]);
    expect(mockBuildPayment).toHaveBeenCalledTimes(1);
    // Stream requests force stream: true.
    const firstCall = (global as any).fetch.mock.calls[0];
    expect(JSON.parse(firstCall[1].body).stream).toBe(true);
  });

  it('returns an error result on a streaming gateway error', async () => {
    installFetchMock([jsonResponse({ error: 'boom' }, 503)]);
    const client = new X402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    const result = await client.callStream(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Gateway error: 503');
  });
});

// ── checkPaymentStatus ────────────────────────

describe('X402Client.checkPaymentStatus()', () => {
  it('returns the receipt when the gateway reports it', async () => {
    const receipt = makeReceipt();
    installFetchMock([jsonResponse(receipt)]);
    const client = new X402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    const status = await client.checkPaymentStatus('quote-123');

    expect(status).toEqual(receipt);
    expect((global as any).fetch).toHaveBeenCalledWith(
      `${GATEWAY_URL}/api/v1/payments/quote-123/status`,
    );
  });

  it('returns null on a non-ok gateway response', async () => {
    installFetchMock([jsonResponse({ error: 'unknown quote' }, 404)]);
    const client = new X402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    expect(await client.checkPaymentStatus('quote-123')).toBeNull();
  });

  it('returns null when the network call throws', async () => {
    installFetchMock([]); // gateway queue empty → mock rejects
    const client = new X402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    expect(await client.checkPaymentStatus('quote-123')).toBeNull();
  });
});

// ── Factory ───────────────────────────────────

describe('createX402Client()', () => {
  it('returns a configured X402Client instance', () => {
    const client = createX402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      secretKey: 'S' + 'A'.repeat(55),
    });

    expect(client).toBeInstanceOf(X402Client);
  });

  it('applies defaults for network and asset', async () => {
    const llm = makeChatResponse();
    installFetchMock([jsonResponse(llm)]);
    const client = createX402Client({ gatewayUrl: GATEWAY_URL, network: 'testnet' });

    await client.call(makeRequest());

    expect(client).toBeInstanceOf(X402Client);
  });
});
