/* eslint-disable @typescript-eslint/no-explicit-any */
import { Keypair, TransactionBuilder, Horizon, Networks } from '@stellar/stellar-sdk';
import {
  generateKeypair,
  keypairFromSecret,
  getNetworkPassphrase,
  getHorizonUrl,
  getSorobanRpcUrl,
  buildPaymentTransaction,
  buildUnsignedPaymentTransaction,
  createHorizonServer,
  accountExists,
  getAccountBalances,
  getTransaction,
  signChallenge,
  verifyChallenge,
} from './index';

// ── Fixtures ──────────────────────────────────

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const CHALLENGE = 'sign-this-challenge-2026';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';

/** Fake Horizon AccountRecord with the methods TransactionBuilder needs. */
function mockSourceAccount(publicKey: string) {
  let seq = 123;
  return {
    accountId: () => publicKey,
    sequenceNumber: () => String(seq),
    incrementSequenceNumber: () => {
      seq += 1;
    },
  };
}

function buildOptions(overrides: Record<string, any> = {}): any {
  return {
    sourceSecret: SOURCE_SECRET,
    destination: DEST_PUBLIC,
    amount: '5.5',
    asset: 'USDC',
    assetIssuer: USDC_ISSUER,
    memo: undefined,
    network: 'testnet',
    horizonUrl: HORIZON_URL,
    ...overrides,
  };
}

const SOURCE_KEYPAIR = Keypair.random();
const SOURCE_SECRET = SOURCE_KEYPAIR.secret();
const SOURCE_PUBLIC = SOURCE_KEYPAIR.publicKey();
const DEST_PUBLIC = Keypair.random().publicKey();

// ── Test harness ──────────────────────────────

let loadAccountSpy: jest.SpyInstance;

beforeEach(() => {
  loadAccountSpy = jest
    .spyOn(Horizon.Server.prototype, 'loadAccount')
    .mockImplementation(async () => mockSourceAccount(SOURCE_PUBLIC) as any);
});

afterEach(() => {
  loadAccountSpy.mockRestore();
  jest.restoreAllMocks();
});

// ── Key management ────────────────────────────

describe('generateKeypair / keypairFromSecret', () => {
  it('generates a valid public/secret key pair', () => {
    const { publicKey, secretKey } = generateKeypair();

    expect(publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(secretKey).toMatch(/^S[A-Z2-7]{55}$/);
    expect(keypairFromSecret(secretKey).publicKey()).toBe(publicKey);
  });

  it('generates distinct keypairs on each call', () => {
    const first = generateKeypair();
    const second = generateKeypair();
    expect(first.publicKey).not.toBe(second.publicKey);
    expect(first.secretKey).not.toBe(second.secretKey);
  });
});

// ── Network configuration ─────────────────────

describe('getNetworkPassphrase', () => {
  it('returns the correct passphrase for each network', () => {
    expect(getNetworkPassphrase('mainnet')).toBe(Networks.PUBLIC);
    expect(getNetworkPassphrase('testnet')).toBe(Networks.TESTNET);
    expect(getNetworkPassphrase('futurenet')).toBe(Networks.FUTURENET);
  });
});

describe('getHorizonUrl', () => {
  it('returns the correct Horizon URL for each network', () => {
    expect(getHorizonUrl('mainnet')).toBe('https://horizon.stellar.org');
    expect(getHorizonUrl('testnet')).toBe('https://horizon-testnet.stellar.org');
    expect(getHorizonUrl('futurenet')).toBe('https://horizon-futurenet.stellar.org');
  });
});

describe('getSorobanRpcUrl', () => {
  it('returns the correct Soroban RPC URL for each network', () => {
    expect(getSorobanRpcUrl('mainnet')).toBe('https://soroban-mainnet.stellar.org');
    expect(getSorobanRpcUrl('testnet')).toBe('https://soroban-testnet.stellar.org');
    expect(getSorobanRpcUrl('futurenet')).toBe('https://rpc-futurenet.stellar.org');
  });
});

describe('createHorizonServer', () => {
  it('creates a testnet server by default', () => {
    expect(createHorizonServer()).toBeInstanceOf(Horizon.Server);
  });

  it('creates a server for the requested network', () => {
    const server = createHorizonServer('mainnet');
    expect(server).toBeInstanceOf(Horizon.Server);
    expect((server.serverURL as any).hostname()).toBe('horizon.stellar.org');
  });

  it('prefers a custom URL when provided', () => {
    const server = createHorizonServer('mainnet', 'https://custom-horizon.example.com');
    expect(server).toBeInstanceOf(Horizon.Server);
    expect((server.serverURL as any).hostname()).toBe('custom-horizon.example.com');
  });
});

// ── Payment transaction builder ───────────────

describe('buildPaymentTransaction', () => {
  it('builds and signs a USDC payment with memo', async () => {
    const result = await buildPaymentTransaction(buildOptions({ memo: 'order-123' }));

    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.txXdr).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(loadAccountSpy).toHaveBeenCalledWith(SOURCE_PUBLIC);

    // The XDR must decode back to the same transaction with the same hash.
    const decoded = TransactionBuilder.fromXDR(result.txXdr, Networks.TESTNET) as any;
    expect(decoded.hash().toString('hex')).toBe(result.txHash);
    expect(decoded.source).toBe(SOURCE_PUBLIC);

    const op = decoded.operations[0];
    expect(op.type).toBe('payment');
    expect(op.destination).toBe(DEST_PUBLIC);
    expect(parseFloat(op.amount)).toBe(5.5);
    expect(op.asset.getCode()).toBe('USDC');
    expect(op.asset.getIssuer()).toBe(USDC_ISSUER);

    const memo = decoded.memo;
    expect(memo.type).toBe('text');
    expect(memo.value.toString()).toBe('order-123');
  });

  it('builds a native XLM payment without an issuer', async () => {
    const result = await buildPaymentTransaction(
      buildOptions({ asset: 'XLM', assetIssuer: undefined }),
    );

    const decoded = TransactionBuilder.fromXDR(result.txXdr, Networks.TESTNET);
    const op = decoded.operations[0] as any;
    expect(op.type).toBe('payment');
    expect(op.asset.isNative()).toBe(true);
    expect(parseFloat(op.amount)).toBe(5.5);
  });

  it('throws for USDC without an issuer', async () => {
    await expect(buildPaymentTransaction(buildOptions({ assetIssuer: undefined }))).rejects.toThrow(
      'Unsupported asset or missing issuer: USDC',
    );
  });

  it('throws for an unsupported asset', async () => {
    await expect(
      buildPaymentTransaction(buildOptions({ asset: 'EURT', assetIssuer: 'GOTHER123' })),
    ).rejects.toThrow('Unsupported asset or missing issuer: EURT');
  });

  it('throws for an invalid source secret key', async () => {
    await expect(
      buildPaymentTransaction(buildOptions({ sourceSecret: 'not-a-secret' })),
    ).rejects.toThrow(/invalid/i);
  });
});

// ── Horizon helpers ───────────────────────────

describe('accountExists', () => {
  it('returns true when the account loads', async () => {
    const server = {
      loadAccount: jest.fn().mockResolvedValue({ id: SOURCE_PUBLIC }),
    } as unknown as Horizon.Server;

    await expect(accountExists(SOURCE_PUBLIC, server)).resolves.toBe(true);
    expect(server.loadAccount).toHaveBeenCalledWith(SOURCE_PUBLIC);
  });

  it('returns false when the account cannot be loaded', async () => {
    const server = {
      loadAccount: jest.fn().mockRejectedValue(new Error('Not found')),
    } as unknown as Horizon.Server;

    await expect(accountExists(SOURCE_PUBLIC, server)).resolves.toBe(false);
  });
});

describe('getAccountBalances', () => {
  it('maps native and issued asset balances', async () => {
    const server = {
      loadAccount: jest.fn().mockResolvedValue({
        balances: [
          { asset_type: 'native', balance: '10.5' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: USDC_ISSUER,
            balance: '25',
          },
        ],
      }),
    } as unknown as Horizon.Server;

    await expect(getAccountBalances(SOURCE_PUBLIC, server)).resolves.toEqual([
      { asset: 'XLM', balance: '10.5' },
      { asset: 'USDC', balance: '25', issuer: USDC_ISSUER },
    ]);
  });

  it('returns an empty array when the account cannot be loaded', async () => {
    const server = {
      loadAccount: jest.fn().mockRejectedValue(new Error('Not found')),
    } as unknown as Horizon.Server;

    await expect(getAccountBalances(SOURCE_PUBLIC, server)).resolves.toEqual([]);
  });
});

describe('getTransaction', () => {
  const TX_HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

  it('returns the transaction when the lookup succeeds', async () => {
    const txRecord = { id: TX_HASH, successful: true };
    const server = {
      transactions: jest.fn().mockReturnValue({
        transaction: jest.fn().mockReturnValue({
          call: jest.fn().mockResolvedValue(txRecord),
        }),
      }),
    } as unknown as Horizon.Server;

    await expect(getTransaction(TX_HASH, server)).resolves.toEqual(txRecord);
    expect(server.transactions().transaction).toHaveBeenCalledWith(TX_HASH);
  });

  it('returns null when the lookup fails', async () => {
    const server = {
      transactions: jest.fn().mockReturnValue({
        transaction: jest.fn().mockReturnValue({
          call: jest.fn().mockRejectedValue(new Error('Not found')),
        }),
      }),
    } as unknown as Horizon.Server;

    await expect(getTransaction(TX_HASH, server)).resolves.toBeNull();
  });
});

// ── Wallet auth signing ───────────────────────

describe('signChallenge / verifyChallenge', () => {
  it('produces a signature that verifies for the same keypair', () => {
    const signature = signChallenge({
      secretKey: SOURCE_SECRET,
      challenge: CHALLENGE,
      network: 'testnet',
    });

    expect(signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(verifyChallenge(SOURCE_PUBLIC, CHALLENGE, signature)).toBe(true);
  });

  it('rejects a signature when the challenge is tampered with', () => {
    const signature = signChallenge({
      secretKey: SOURCE_SECRET,
      challenge: CHALLENGE,
      network: 'testnet',
    });

    expect(verifyChallenge(SOURCE_PUBLIC, CHALLENGE + '-tampered', signature)).toBe(false);
  });

  it('rejects a signature from a different keypair', () => {
    const otherSignature = signChallenge({
      secretKey: Keypair.random().secret(),
      challenge: CHALLENGE,
      network: 'testnet',
    });

    expect(verifyChallenge(SOURCE_PUBLIC, CHALLENGE, otherSignature)).toBe(false);
  });

  it('rejects a signature that is not valid base64', () => {
    expect(verifyChallenge(SOURCE_PUBLIC, CHALLENGE, '!!!not-base64!!!')).toBe(false);
  });
});

// ── Unsigned transaction builder (external signing) ─────────
// Issue #8: cover the externally-signed payment builder used by wallet
// extensions / agent SDKs. These must NOT sign — they return an unsigned XDR
// that a separate signer can complete.

describe('buildUnsignedPaymentTransaction', () => {
  it('returns an unsigned XDR + hash for a USDC payment', async () => {
    const result = await buildUnsignedPaymentTransaction({
      sourcePublicKey: SOURCE_PUBLIC,
      destination: DEST_PUBLIC,
      amount: '5.5',
      asset: 'USDC',
      assetIssuer: USDC_ISSUER,
      memo: undefined,
      network: 'testnet',
      horizonUrl: HORIZON_URL,
    });

    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.txXdr).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(loadAccountSpy).toHaveBeenCalledWith(SOURCE_PUBLIC);

    const decoded = TransactionBuilder.fromXDR(result.txXdr, Networks.TESTNET) as any;
    expect(decoded.hash().toString('hex')).toBe(result.txHash);
    expect(decoded.source).toBe(SOURCE_PUBLIC);

    const op = decoded.operations[0];
    expect(op.type).toBe('payment');
    expect(op.destination).toBe(DEST_PUBLIC);
    expect(parseFloat(op.amount)).toBe(5.5);
    expect(op.asset.getCode()).toBe('USDC');
    expect(op.asset.getIssuer()).toBe(USDC_ISSUER);

    // Critical: the unsigned builder must NOT have been signed yet.
    expect(decoded.signatures).toHaveLength(0);
  });

  it('builds a native XLM payment without an issuer and leaves it unsigned', async () => {
    const result = await buildUnsignedPaymentTransaction({
      sourcePublicKey: SOURCE_PUBLIC,
      destination: DEST_PUBLIC,
      amount: '5.5',
      asset: 'XLM',
      assetIssuer: undefined,
      memo: undefined,
      network: 'testnet',
      horizonUrl: HORIZON_URL,
    });

    const decoded = TransactionBuilder.fromXDR(result.txXdr, Networks.TESTNET) as any;
    expect(decoded.operations[0].asset.isNative()).toBe(true);
    expect(decoded.signatures).toHaveLength(0);
  });

  it('attaches a memo when provided and leaves it unsigned', async () => {
    const result = await buildUnsignedPaymentTransaction({
      sourcePublicKey: SOURCE_PUBLIC,
      destination: DEST_PUBLIC,
      amount: '1',
      asset: 'XLM',
      assetIssuer: undefined,
      memo: 'ext-signer-order',
      network: 'testnet',
      horizonUrl: HORIZON_URL,
    });

    const decoded = TransactionBuilder.fromXDR(result.txXdr, Networks.TESTNET) as any;
    expect(decoded.memo.type).toBe('text');
    expect(decoded.memo.value.toString()).toBe('ext-signer-order');
    expect(decoded.signatures).toHaveLength(0);
  });

  it('throws for USDC without an issuer', async () => {
    await expect(
      buildUnsignedPaymentTransaction({
        sourcePublicKey: SOURCE_PUBLIC,
        destination: DEST_PUBLIC,
        amount: '5.5',
        asset: 'USDC',
        assetIssuer: undefined,
        network: 'testnet',
        horizonUrl: HORIZON_URL,
      }),
    ).rejects.toThrow('Unsupported asset or missing issuer: USDC');
  });

  it('produces an XDR the signed builder can complete (round-trip)', async () => {
    const unsigned = await buildUnsignedPaymentTransaction({
      sourcePublicKey: SOURCE_PUBLIC,
      destination: DEST_PUBLIC,
      amount: '5.5',
      asset: 'USDC',
      assetIssuer: USDC_ISSUER,
      network: 'testnet',
      horizonUrl: HORIZON_URL,
    });

    // Simulate an external signer completing the unsigned XDR with the source key.
    const tx = TransactionBuilder.fromXDR(unsigned.txXdr, Networks.TESTNET);
    tx.sign(SOURCE_KEYPAIR);
    const signedXdr = tx.toXDR();
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as any;
    expect(signed.signatures).toHaveLength(1);
    expect(signed.hash().toString('hex')).toBe(unsigned.txHash);
  });
});
