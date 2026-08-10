import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import {
  accountExists,
  buildPaymentTransaction,
  getAccountBalances,
  getTransaction,
} from './index';

const mockLoadAccount = jest.fn();
const mockTransactionCall = jest.fn();
const mockTransactionLookup = jest.fn(() => ({ call: mockTransactionCall }));
const mockTransactions = jest.fn(() => ({ transaction: mockTransactionLookup }));

interface MockAccount {
  accountId: () => string;
  sequenceNumber: () => string;
  incrementSequenceNumber: () => void;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
  }>;
}

interface DecodedPaymentTransaction {
  source: string;
  memo: { value: Uint8Array };
  operations: Array<{
    type: string;
    destination: string;
    amount: string;
    asset: Asset;
  }>;
  fee: string | number;
  signatures: Array<{ hint: () => Buffer }>;
  hash: () => Buffer;
}

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn(() => ({
        loadAccount: mockLoadAccount,
        transactions: mockTransactions,
      })),
    },
  };
});

function makeAccount(publicKey: string, sequence = '123456789'): MockAccount {
  let currentSequence = BigInt(sequence);

  return {
    accountId: () => publicKey,
    sequenceNumber: () => currentSequence.toString(),
    incrementSequenceNumber: () => {
      currentSequence += 1n;
    },
    balances: [
      {
        asset_type: 'native',
        balance: '42.0000000',
      },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
        balance: '100.0000000',
      },
    ],
  };
}

describe('@x402/wallet transaction builder', () => {
  const source = Keypair.random();
  const destination = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadAccount.mockResolvedValue(makeAccount(source.publicKey()));
  });

  it('builds a signed USDC payment transaction with the expected destination, amount, and asset', async () => {
    const result = await buildPaymentTransaction({
      sourceSecret: source.secret(),
      destination,
      amount: '12.3456789',
      asset: 'USDC',
      assetIssuer: issuer,
      memo: 'quote-123',
      network: 'testnet',
      horizonUrl: 'https://horizon.example.test',
    });

    const tx = TransactionBuilder.fromXDR(
      result.txXdr,
      Networks.TESTNET,
    ) as unknown as DecodedPaymentTransaction;
    const [operation] = tx.operations;

    expect(Horizon.Server).toHaveBeenCalledWith('https://horizon.example.test');
    expect(mockLoadAccount).toHaveBeenCalledWith(source.publicKey());
    expect(tx.source).toBe(source.publicKey());
    expect(Buffer.from(tx.memo.value).toString('utf8')).toBe('quote-123');
    expect(operation.type).toBe('payment');
    expect(operation.destination).toBe(destination);
    expect(operation.amount).toBe('12.3456789');
    expect(operation.asset).toBeInstanceOf(Asset);
    expect(operation.asset.getCode()).toBe('USDC');
    expect(operation.asset.getIssuer()).toBe(issuer);
    expect(result.txHash).toBe(tx.hash().toString('hex'));
  });

  it('uses the Stellar base fee for a single-operation payment transaction', async () => {
    const { txXdr } = await buildPaymentTransaction({
      sourceSecret: source.secret(),
      destination,
      amount: '1',
      asset: 'XLM',
      network: 'testnet',
      horizonUrl: 'https://horizon.example.test',
    });

    const tx = TransactionBuilder.fromXDR(
      txXdr,
      Networks.TESTNET,
    ) as unknown as DecodedPaymentTransaction;

    expect(tx.operations).toHaveLength(1);
    expect(Number(tx.fee)).toBe(Number(BASE_FEE));
  });

  it('signs the transaction with the source keypair', async () => {
    const { txXdr } = await buildPaymentTransaction({
      sourceSecret: source.secret(),
      destination,
      amount: '5',
      asset: 'XLM',
      network: 'testnet',
      horizonUrl: 'https://horizon.example.test',
    });

    const tx = TransactionBuilder.fromXDR(
      txXdr,
      Networks.TESTNET,
    ) as unknown as DecodedPaymentTransaction;

    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0].hint().toString('hex')).toBe(
      source.rawPublicKey().subarray(-4).toString('hex'),
    );
  });

  it('surfaces Horizon account-load errors without submitting a transaction', async () => {
    const error = new Error('Horizon unavailable');
    mockLoadAccount.mockRejectedValueOnce(error);

    await expect(
      buildPaymentTransaction({
        sourceSecret: source.secret(),
        destination,
        amount: '1',
        asset: 'XLM',
        network: 'testnet',
        horizonUrl: 'https://horizon.example.test',
      }),
    ).rejects.toThrow('Horizon unavailable');

    expect(mockTransactions).not.toHaveBeenCalled();
  });

  it('returns false when account existence checks receive a Horizon error', async () => {
    mockLoadAccount.mockRejectedValueOnce(new Error('not found'));
    const server = new Horizon.Server('https://horizon.example.test');

    await expect(accountExists(destination, server)).resolves.toBe(false);
  });

  it('maps native and issued account balances from mocked Horizon responses', async () => {
    const server = new Horizon.Server('https://horizon.example.test');

    await expect(getAccountBalances(source.publicKey(), server)).resolves.toEqual([
      { asset: 'XLM', balance: '42.0000000', issuer: undefined },
      {
        asset: 'USDC',
        balance: '100.0000000',
        issuer: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
      },
    ]);
  });

  it('returns null when Horizon transaction lookup fails', async () => {
    mockTransactionCall.mockRejectedValueOnce(new Error('lookup failed'));
    const server = new Horizon.Server('https://horizon.example.test');

    await expect(getTransaction('tx-hash', server)).resolves.toBeNull();
    expect(mockTransactions).toHaveBeenCalledTimes(1);
    expect(mockTransactionLookup).toHaveBeenCalledWith('tx-hash');
  });
});
