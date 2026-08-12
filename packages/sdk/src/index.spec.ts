/* eslint-disable @typescript-eslint/no-explicit-any */
// ──────────────────────────────────────────────
// @x402/sdk — Unit tests for call, streaming, signer paths
// ──────────────────────────────────────────────

import { X402Client, createX402Client } from './index';

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  PaymentRequiredResponse,
  Quote,
  PaymentReceipt,
  X402ClientConfig,
} from '@x402/types';

// ── Mocks ─────────────────────────────────────

// Mock the @x402/wallet module so executePayment never hits the network
jest.mock('@x402/wallet', () => ({
  buildPaymentTransaction: jest.fn(),
  buildUnsignedPaymentTransaction: jest.fn(),
  createHorizonServer: jest.fn(),
}));

// Mock @x402/logger so tests don't print noise
jest.mock('@x402/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock @x402/shared sleep so tests don't actually wait
jest.mock('@x402/shared', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
  stroopsToUnits: jest.fn((stroops: string) => {
    // Convert stroops (1e-7) to units — for testing just return the same string
    const n = BigInt(stroops);
    return (Number(n) / 1e7).toString();
  }),
}));

import {
  buildPaymentTransaction,
  buildUnsignedPaymentTransaction,
  createHorizonServer,
} from '@x402/wallet';

// ── Fixtures ──────────────────────────────────

const GATEWAY_URL = 'https://gateway.example.com';
const SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const PUBLIC_KEY = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

const VALID_QUOTE: Quote = {
  id: 'quote-123',
  route: '/v1/chat/completions',
  pricingModel: 'flat',
  amount: '10000000', // 1 USDC in stroops
  asset: 'USDC',
  assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  paymentAddress: 'GDESTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  memo: 'x402-quote-123',
  expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
  network: 'testnet',
  statusUrl: 'https://gateway.example.com/api/v1/payments/quote-123/status',
};

const CHAT_REQUEST: ChatCompletionRequest = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }],
};

const PAYMENT_RECEIPT: PaymentReceipt = {
  id: 'receipt-123',
  quoteId: 'quote-123',
  txHash: 'abc123txhash',
  payerAddress: 'GXXXX',
  amount: '10000000',
  asset: 'USDC',
  route: '/v1/chat/completions',
  status: 'confirmed',
  verifiedAt: new Date().toISOString(),
  ledger: 12345,
};

// ── Helpers ───────────────────────────────────

/** Create a mock Response object with the given fields */
function mockResponse(status: number, body: any, headers: Record<string, string> = {}): Response {
  const res = {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    body: {
      cancel: jest.fn(),
      getReader: jest.fn(),
    },
  } as unknown as Response;
  return res;
}

/** Create a mock Response with a ReadableStream body for SSE testing */
function mockStreamResponse(
  status: number,
  sseChunks: string[],
  headers: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of sseChunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: jest.fn(),
    text: jest.fn(),
    body: stream,
  } as unknown as Response;
}

function makePaymentRequired(overrides: Partial<Quote> = {}): PaymentRequiredResponse {
  return {
    quote: { ...VALID_QUOTE, ...overrides },
  } as PaymentRequiredResponse;
}

function makeChatResponse(): ChatCompletionResponse {
  return {
    id: 'chat-123',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-4',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      },
    ],
  } as ChatCompletionResponse;
}

/** Create a client config with all fields set */
function makeConfig(overrides: Partial<X402ClientConfig> = {}): X402ClientConfig {
  return {
    gatewayUrl: GATEWAY_URL,
    network: 'testnet',
    secretKey: SECRET_KEY,
    ...overrides,
  };
}

// ── Test Harness ──────────────────────────────

let fetchMock: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock = jest.spyOn(globalThis, 'fetch') as jest.SpyInstance;
});

afterEach(() => {
  fetchMock.mockRestore();
});

// ── Tests ──────────────────────────────────────

describe('createX402Client', () => {
  it('creates an instance with default config merged', () => {
    const client = createX402Client(makeConfig());
    expect(client).toBeInstanceOf(X402Client);
  });
});

describe('X402Client.call()', () => {
  it('returns success on 200 OK without payment', async () => {
    const client = new X402Client(makeConfig());
    fetchMock.mockResolvedValueOnce(mockResponse(200, makeChatResponse()));

    const result = await client.call(CHAT_REQUEST);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.response).toBeDefined();
      expect(result.cost).toEqual({ amount: '0', asset: 'USDC' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles 402 → pay → retry flow with secretKey', async () => {
    const client = new X402Client(makeConfig());

    // First fetch: 402 response
    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired()));

    // Mock wallet payment building
    (buildPaymentTransaction as jest.Mock).mockResolvedValue({
      txXdr: 'base64xdrdata',
      txHash: 'abc123txhash',
    });
    (createHorizonServer as jest.Mock).mockReturnValue({
      submitTransaction: jest.fn().mockResolvedValue({}),
    });

    // Second fetch: waitForConfirmation — horizon returns successful tx
    fetchMock.mockResolvedValueOnce(mockResponse(200, { successful: true }));

    // Third fetch: retry request with payment proof
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, makeChatResponse(), {
        'X-Payment-Receipt': JSON.stringify(PAYMENT_RECEIPT),
      }),
    );

    const result = await client.call(CHAT_REQUEST);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.response).toBeDefined();
      expect(result.receipt).toBeDefined();
      expect(result.receipt?.txHash).toBe('abc123txhash');
      expect(result.cost?.asset).toBe('USDC');
    }
    // fetch called: initial 402 + confirmation + retry
    expect(fetchMock).toHaveBeenCalled();
  });

  it('returns error on quote expiry', async () => {
    const client = new X402Client(makeConfig());

    fetchMock.mockResolvedValueOnce(
      mockResponse(402, makePaymentRequired({ expiresAt: Math.floor(Date.now() / 1000) - 100 })),
    );

    const result = await client.call(CHAT_REQUEST);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('expired');
    }
  });

  it('returns error on wrong asset', async () => {
    const client = new X402Client(makeConfig({ defaultAsset: 'USDC' }));

    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired({ asset: 'XLM' })));

    const result = await client.call(CHAT_REQUEST, { asset: 'USDC' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Wrong asset');
      expect(result.error).toContain('XLM');
    }
  });

  it('returns error on gateway error (non-402, non-200)', async () => {
    const client = new X402Client(makeConfig());

    fetchMock.mockResolvedValueOnce(mockResponse(500, 'Internal Server Error'));

    const result = await client.call(CHAT_REQUEST);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('500');
    }
  });

  it('returns error when no secretKey and no signTransaction', async () => {
    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      // No secretKey, no signTransaction
    });

    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired()));

    const result = await client.call(CHAT_REQUEST);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Payment required');
      expect(result.error).toContain('10000000');
    }
  });

  it('returns error on payment failure (secretKey path)', async () => {
    const client = new X402Client(makeConfig());

    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired()));

    (buildPaymentTransaction as jest.Mock).mockRejectedValue(new Error('Insufficient balance'));

    const result = await client.call(CHAT_REQUEST);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Payment failed');
      expect(result.error).toContain('Insufficient balance');
    }
  });

  it('returns error on gateway error after payment', async () => {
    const client = new X402Client(makeConfig());

    // 402 first
    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired()));

    // Mock wallet payment
    (buildPaymentTransaction as jest.Mock).mockResolvedValue({
      txXdr: 'base64xdrdata',
      txHash: 'abc123txhash',
    });
    (createHorizonServer as jest.Mock).mockReturnValue({
      submitTransaction: jest.fn().mockResolvedValue({}),
    });

    // Confirmation fetch
    fetchMock.mockResolvedValueOnce(mockResponse(200, { successful: true }));

    // Retry returns 500
    fetchMock.mockResolvedValueOnce(mockResponse(500, 'Payment verification failed'));

    const result = await client.call(CHAT_REQUEST);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Gateway error after payment');
    }
  });
});

describe('X402Client.callStream()', () => {
  it('handles 200 OK with SSE stream', async () => {
    const client = new X402Client(makeConfig());

    const sseData = [
      `data: ${JSON.stringify({ id: 'chat-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' } }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chat-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: ' there' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce(mockStreamResponse(200, sseData));

    const result = await client.callStream(CHAT_REQUEST);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeDefined();
      const chunks: any[] = [];
      for await (const chunk of result.stream as AsyncGenerator<any>) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(2);
      expect(chunks[0].choices[0].delta.content).toBe('Hi');
      expect(chunks[1].choices[0].delta.content).toBe(' there');
    }
  });

  it('parses x402_receipt from trailing SSE event', async () => {
    const client = new X402Client(makeConfig());

    const receiptEvent = { x402_receipt: PAYMENT_RECEIPT };
    const sseData = [
      `data: ${JSON.stringify({ id: 'chat-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' } }] })}\n\n`,
      `data: ${JSON.stringify(receiptEvent)}\n\n`,
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce(mockStreamResponse(200, sseData));

    const result = await client.callStream(CHAT_REQUEST);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeDefined();
      const chunks: any[] = [];
      for await (const chunk of result.stream as AsyncGenerator<any>) {
        chunks.push(chunk);
      }
      // Only the LLM chunk should be yielded, not the receipt
      expect(chunks).toHaveLength(1);
    }
  });

  it('handles 402 → pay → retry for streaming', async () => {
    const client = new X402Client(makeConfig());

    // First fetch: 402
    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired()));

    // Mock wallet payment
    (buildPaymentTransaction as jest.Mock).mockResolvedValue({
      txXdr: 'base64xdrdata',
      txHash: 'abc123txhash',
    });
    (createHorizonServer as jest.Mock).mockReturnValue({
      submitTransaction: jest.fn().mockResolvedValue({}),
    });

    // Confirmation fetch
    fetchMock.mockResolvedValueOnce(mockResponse(200, { successful: true }));

    // Retry: streaming response
    const sseData = [
      `data: ${JSON.stringify({ id: 'chat-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce(
      mockStreamResponse(200, sseData, {
        'X-Payment-Receipt': JSON.stringify(PAYMENT_RECEIPT),
      }),
    );

    const result = await client.callStream(CHAT_REQUEST);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stream).toBeDefined();
      expect(result.receipt).toBeDefined();
      expect(result.cost).toBeDefined();
    }
  });

  it('returns error on gateway error for streaming', async () => {
    const client = new X402Client(makeConfig());

    fetchMock.mockResolvedValueOnce(mockResponse(500, 'Internal Server Error'));

    const result = await client.callStream(CHAT_REQUEST);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('500');
    }
  });
});

describe('X402Client.executePayment (via call)', () => {
  it('uses external signTransaction path when provided', async () => {
    const signTransaction = jest.fn().mockResolvedValue('signedXdrBase64');

    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      publicKey: PUBLIC_KEY,
      signTransaction,
    });

    // 402 first
    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired()));

    // Mock wallet unsigned payment building
    (buildUnsignedPaymentTransaction as jest.Mock).mockResolvedValue({
      txXdr: 'unsignedXdrBase64',
      txHash: 'abc123txhash',
    });
    (createHorizonServer as jest.Mock).mockReturnValue({
      submitTransaction: jest.fn().mockResolvedValue({}),
    });

    // Confirmation fetch
    fetchMock.mockResolvedValueOnce(mockResponse(200, { successful: true }));

    // Retry: success
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, makeChatResponse(), {
        'X-Payment-Receipt': JSON.stringify(PAYMENT_RECEIPT),
      }),
    );

    const result = await client.call(CHAT_REQUEST);

    expect(signTransaction).toHaveBeenCalledWith('unsignedXdrBase64');
    expect(buildUnsignedPaymentTransaction).toHaveBeenCalled();
    expect(buildPaymentTransaction).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('returns error when signTransaction is set but publicKey is missing', async () => {
    const signTransaction = jest.fn();

    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      signTransaction,
      // No publicKey
    });

    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired()));

    const result = await client.call(CHAT_REQUEST);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('publicKey is required');
    }
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('returns error on external signer failure', async () => {
    const signTransaction = jest.fn().mockRejectedValue(new Error('User rejected'));

    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      publicKey: PUBLIC_KEY,
      signTransaction,
    });

    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired()));

    (buildUnsignedPaymentTransaction as jest.Mock).mockResolvedValue({
      txXdr: 'unsignedXdrBase64',
      txHash: 'abc123txhash',
    });

    const result = await client.call(CHAT_REQUEST);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('External payment failed');
      expect(result.error).toContain('User rejected');
    }
  });
});

describe('X402Client.checkPaymentStatus()', () => {
  it('returns receipt on success', async () => {
    const client = new X402Client(makeConfig());

    fetchMock.mockResolvedValueOnce(mockResponse(200, PAYMENT_RECEIPT));

    const result = await client.checkPaymentStatus('quote-123');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('receipt-123');
    expect(result?.txHash).toBe('abc123txhash');
  });

  it('returns null on non-ok response', async () => {
    const client = new X402Client(makeConfig());

    fetchMock.mockResolvedValueOnce(mockResponse(404, { error: 'Not found' }));

    const result = await client.checkPaymentStatus('nonexistent');

    expect(result).toBeNull();
  });

  it('returns null on fetch error', async () => {
    const client = new X402Client(makeConfig());

    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const result = await client.checkPaymentStatus('quote-123');

    expect(result).toBeNull();
  });
});

describe('waitForConfirmation (via 402 flow)', () => {
  it('returns "not confirmed" error when waitForConfirmation times out', async () => {
    const client = new X402Client(makeConfig({ paymentTimeout: 1 }));

    // 402
    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired()));

    // Mock wallet payment
    (buildPaymentTransaction as jest.Mock).mockResolvedValue({
      txXdr: 'base64xdrdata',
      txHash: 'abc123txhash',
    });
    (createHorizonServer as jest.Mock).mockReturnValue({
      submitTransaction: jest.fn().mockResolvedValue({}),
    });

    // Confirmation fetch: transaction not found (404) → loop until timeout
    fetchMock.mockResolvedValue(mockResponse(404, { error: 'Not found' }));

    const result = await client.call(CHAT_REQUEST);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not confirmed within timeout');
    }
  });

  it('returns "not confirmed" error when external signer payment times out', async () => {
    const signTransaction = jest.fn().mockResolvedValue('signedXdrBase64');

    const client = new X402Client({
      gatewayUrl: GATEWAY_URL,
      network: 'testnet',
      publicKey: PUBLIC_KEY,
      signTransaction,
      paymentTimeout: 1,
    });

    // 402
    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired()));

    // Mock wallet unsigned payment
    (buildUnsignedPaymentTransaction as jest.Mock).mockResolvedValue({
      txXdr: 'unsignedXdrBase64',
      txHash: 'abc123txhash',
    });
    (createHorizonServer as jest.Mock).mockReturnValue({
      submitTransaction: jest.fn().mockResolvedValue({}),
    });

    // Confirmation fetch: always 404 → times out
    fetchMock.mockResolvedValue(mockResponse(404, { error: 'Not found' }));

    const result = await client.call(CHAT_REQUEST);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not confirmed within timeout');
    }
  });
});

describe('getHorizonUrl (via config)', () => {
  it('uses mainnet horizon URL when configured', async () => {
    const client = new X402Client(makeConfig({ network: 'mainnet' }));

    // 402 with mainnet quote
    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired({ network: 'mainnet' })));

    (buildPaymentTransaction as jest.Mock).mockResolvedValue({
      txXdr: 'base64xdrdata',
      txHash: 'abc123txhash',
    });
    (createHorizonServer as jest.Mock).mockReturnValue({
      submitTransaction: jest.fn().mockResolvedValue({}),
    });

    // waitForConfirmation fetch — check it hits the mainnet horizon URL
    fetchMock.mockResolvedValueOnce(mockResponse(200, { successful: true }));

    // Retry
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, makeChatResponse(), {
        'X-Payment-Receipt': JSON.stringify(PAYMENT_RECEIPT),
      }),
    );

    await client.call(CHAT_REQUEST);

    // The 3rd fetch (index 2) should be to horizon.stellar.org
    const confirmationCall = fetchMock.mock.calls[1];
    expect(confirmationCall[0]).toContain('horizon.stellar.org');
  });

  it('uses futurenet horizon URL when configured', async () => {
    const client = new X402Client(makeConfig({ network: 'futurenet' }));

    // 402 with futurenet quote
    fetchMock.mockResolvedValueOnce(
      mockResponse(402, makePaymentRequired({ network: 'futurenet' })),
    );

    (buildPaymentTransaction as jest.Mock).mockResolvedValue({
      txXdr: 'base64xdrdata',
      txHash: 'abc123txhash',
    });
    (createHorizonServer as jest.Mock).mockReturnValue({
      submitTransaction: jest.fn().mockResolvedValue({}),
    });

    // waitForConfirmation
    fetchMock.mockResolvedValueOnce(mockResponse(200, { successful: true }));

    // Retry
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, makeChatResponse(), {
        'X-Payment-Receipt': JSON.stringify(PAYMENT_RECEIPT),
      }),
    );

    await client.call(CHAT_REQUEST);

    const confirmationCall = fetchMock.mock.calls[1];
    expect(confirmationCall[0]).toContain('horizon-futurenet.stellar.org');
  });
});

describe('parseReceiptHeader (edge cases)', () => {
  it('returns undefined on malformed JSON receipt header', async () => {
    const client = new X402Client(makeConfig());

    // 200 response with a malformed receipt header
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, makeChatResponse(), {
        'X-Payment-Receipt': 'not-valid-json{',
      }),
    );

    const result = await client.callStream(CHAT_REQUEST);

    expect(result.success).toBe(true);
    if (result.success) {
      // Receipt should be undefined (malformed JSON)
      expect(result.receipt).toBeUndefined();
    }
  });

  it('returns undefined when receipt header is null on 200 stream', async () => {
    const client = new X402Client(makeConfig());

    const sseData = [
      `data: ${JSON.stringify({ id: 'chat-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce(mockStreamResponse(200, sseData));

    const result = await client.callStream(CHAT_REQUEST);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.receipt).toBeUndefined();
    }
  });

  it('extracts cost from receipt header on 200 stream', async () => {
    const client = new X402Client(makeConfig());

    const sseData = [
      `data: ${JSON.stringify({ id: 'chat-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce(
      mockStreamResponse(200, sseData, {
        'X-Payment-Receipt': JSON.stringify(PAYMENT_RECEIPT),
      }),
    );

    const result = await client.callStream(CHAT_REQUEST);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.receipt).toBeDefined();
      expect(result.receipt?.txHash).toBe('abc123txhash');
      expect(result.cost).toBeDefined();
      expect(result.cost?.amount).toBe('10000000');
      expect(result.cost?.asset).toBe('USDC');
    }
  });

  it('extracts cost from receipt header on 402 streaming retry', async () => {
    const client = new X402Client(makeConfig());

    // 402
    fetchMock.mockResolvedValueOnce(mockResponse(402, makePaymentRequired()));

    // Mock wallet payment
    (buildPaymentTransaction as jest.Mock).mockResolvedValue({
      txXdr: 'base64xdrdata',
      txHash: 'abc123txhash',
    });
    (createHorizonServer as jest.Mock).mockReturnValue({
      submitTransaction: jest.fn().mockResolvedValue({}),
    });

    // Confirmation fetch
    fetchMock.mockResolvedValueOnce(mockResponse(200, { successful: true }));

    // Retry: streaming response WITH receipt header
    const sseData = [
      `data: ${JSON.stringify({ id: 'chat-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce(
      mockStreamResponse(200, sseData, {
        'X-Payment-Receipt': JSON.stringify(PAYMENT_RECEIPT),
      }),
    );

    const result = await client.callStream(CHAT_REQUEST);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.receipt).toBeDefined();
      expect(result.receipt?.txHash).toBe('abc123txhash');
      expect(result.cost).toBeDefined();
      expect(result.cost?.asset).toBe('USDC');
    }
  });

  it('handles SSE stream with no body', async () => {
    const client = new X402Client(makeConfig());

    // 200 response with null body
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: jest.fn(),
      text: jest.fn(),
      body: null,
    } as unknown as Response);

    const result = await client.callStream(CHAT_REQUEST);

    expect(result.success).toBe(true);
    if (result.success) {
      const chunks: any[] = [];
      for await (const chunk of result.stream as AsyncGenerator<any>) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(0);
    }
  });

  it('handles SSE stream with unparseable data lines', async () => {
    const client = new X402Client(makeConfig());

    const sseData = [
      'data: not-json-garbage\n\n',
      `data: ${JSON.stringify({ id: 'chat-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];

    fetchMock.mockResolvedValueOnce(mockStreamResponse(200, sseData));

    const result = await client.callStream(CHAT_REQUEST);

    expect(result.success).toBe(true);
    if (result.success) {
      const chunks: any[] = [];
      for await (const chunk of result.stream as AsyncGenerator<any>) {
        chunks.push(chunk);
      }
      // Only the valid JSON chunk should be yielded, garbage is skipped
      expect(chunks).toHaveLength(1);
    }
  });
});
