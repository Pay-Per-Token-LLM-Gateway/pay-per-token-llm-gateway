import {
  generateKeypair,
  keypairFromSecret,
  getNetworkPassphrase,
  getHorizonUrl,
  getSorobanRpcUrl,
  buildPaymentTransaction,
  createHorizonServer,
  accountExists,
  getAccountBalances,
  getTransaction,
  signChallenge,
  verifyChallenge,
} from './index';

// ── Mocks ──────────────────────────────────────

jest.mock('@stellar/stellar-sdk', () => {
  const mockKeypair = {
    random: jest.fn(),
    fromSecret: jest.fn(),
    fromPublicKey: jest.fn(),
  };

  const mockTransactionBuilder = {
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    addMemo: jest.fn().mockReturnThis(),
    build: jest.fn(),
  };

  const mockServer = {
    loadAccount: jest.fn(),
    transactions: jest.fn(),
  };

  // Mock Horizon.Server constructor
  const MockServer = jest.fn().mockImplementation(() => mockServer);

  const mockAsset = jest.fn().mockImplementation((code: string, issuer: string) => ({
    code,
    issuer,
    type: 'credit_alphanum4',
  })) as unknown as { native: jest.Mock };
  mockAsset.native = jest.fn().mockReturnValue({ type: 'native' });

  const mockMemo = jest.fn();
  const mockMemoText = 'text';

  return {
    Keypair: mockKeypair,
    TransactionBuilder: jest.fn().mockImplementation(() => mockTransactionBuilder),
    Operation: {
      payment: jest.fn(),
    },
    Asset: mockAsset,
    Networks: {
      PUBLIC: 'Public Global Stellar Network ; September 2015',
      TESTNET: 'Test SDF Network ; September 2015',
      FUTURENET: 'Future Network ; September 2022',
    },
    Horizon: {
      Server: MockServer,
    },
    BASE_FEE: '100',
    Memo: mockMemo,
    MemoText: mockMemoText,
  };
});

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Horizon,
  Memo,
  MemoText,
} from '@stellar/stellar-sdk';

// Helper to get the mock server instance
function getMockServer() {
  const MockServer = Horizon.Server as jest.Mock;
  return MockServer.mock.results[0]?.value;
}

// ── Tests ──────────────────────────────────────

describe('generateKeypair', () => {
  it('generates a keypair with publicKey and secretKey', () => {
    const mockKp = {
      publicKey: () => 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
      secret: () => 'SBWG2M6Y7O5SECRETKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    };
    (Keypair.random as jest.Mock).mockReturnValue(mockKp);

    const result = generateKeypair();

    expect(result.publicKey).toBe('GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F');
    expect(result.secretKey).toBe('SBWG2M6Y7O5SECRETKEY1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(Keypair.random).toHaveBeenCalled();
  });
});

describe('keypairFromSecret', () => {
  it('parses a secret key into a Keypair', () => {
    const mockKp = { publicKey: () => 'GA5ZSE...' };
    (Keypair.fromSecret as jest.Mock).mockReturnValue(mockKp);

    const result = keypairFromSecret('SBSECRET...');

    expect(result).toBe(mockKp);
    expect(Keypair.fromSecret).toHaveBeenCalledWith('SBSECRET...');
  });
});

describe('getNetworkPassphrase', () => {
  it('returns mainnet passphrase', () => {
    expect(getNetworkPassphrase('mainnet')).toBe('Public Global Stellar Network ; September 2015');
  });

  it('returns testnet passphrase', () => {
    expect(getNetworkPassphrase('testnet')).toBe('Test SDF Network ; September 2015');
  });

  it('returns futurenet passphrase', () => {
    expect(getNetworkPassphrase('futurenet')).toBe('Future Network ; September 2022');
  });
});

describe('getHorizonUrl', () => {
  it('returns mainnet Horizon URL', () => {
    expect(getHorizonUrl('mainnet')).toBe('https://horizon.stellar.org');
  });

  it('returns testnet Horizon URL', () => {
    expect(getHorizonUrl('testnet')).toBe('https://horizon-testnet.stellar.org');
  });

  it('returns futurenet Horizon URL', () => {
    expect(getHorizonUrl('futurenet')).toBe('https://horizon-futurenet.stellar.org');
  });
});

describe('getSorobanRpcUrl', () => {
  it('returns mainnet Soroban RPC URL', () => {
    expect(getSorobanRpcUrl('mainnet')).toBe('https://soroban-mainnet.stellar.org');
  });

  it('returns testnet Soroban RPC URL', () => {
    expect(getSorobanRpcUrl('testnet')).toBe('https://soroban-testnet.stellar.org');
  });

  it('returns futurenet Soroban RPC URL', () => {
    expect(getSorobanRpcUrl('futurenet')).toBe('https://rpc-futurenet.stellar.org');
  });
});

describe('buildPaymentTransaction', () => {
  const mockSourceKeypair = {
    publicKey: () => 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
    sign: jest.fn(),
  };

  const mockAccount = {
    accountId: () => 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
    sequenceNumber: () => '123456',
  };

  const mockTx = {
    toXDR: () => 'AAAAAgAAAAB...base64-xdr...',
    hash: () =>
      Buffer.from('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2', 'hex'),
    sign: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    (Keypair.fromSecret as jest.Mock).mockReturnValue(mockSourceKeypair);

    // Reset TransactionBuilder mock chain
    const mockTxBuilder = {
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      addMemo: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue(mockTx),
    };
    (TransactionBuilder as unknown as jest.Mock).mockImplementation(() => mockTxBuilder);

    // Mock Horizon.Server
    const mockServerInstance = {
      loadAccount: jest.fn().mockResolvedValue(mockAccount),
    };
    (Horizon.Server as unknown as jest.Mock).mockImplementation(() => mockServerInstance);

    // Mock Asset.native
    (Asset.native as jest.Mock).mockReturnValue({ type: 'native' });
  });

  it('builds a payment transaction with correct amount, asset, and destination', async () => {
    const result = await buildPaymentTransaction({
      sourceSecret: 'SBSECRET...',
      destination: 'GBCQV4J5X6K7L8M9N0O1P2Q3R4S5T6U7V8W9X0Y1Z2A3B4C5D6E7F8G9H0I1J2',
      amount: '1000000',
      asset: 'XLM',
      network: 'testnet',
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });

    // Verify the result shape
    expect(result).toHaveProperty('txXdr');
    expect(result).toHaveProperty('txHash');
    expect(result.txHash).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2');

    // Verify Keypair was created from secret
    expect(Keypair.fromSecret).toHaveBeenCalledWith('SBSECRET...');

    // Verify Horizon server was created with correct URL
    expect(Horizon.Server).toHaveBeenCalledWith('https://horizon-testnet.stellar.org');

    // Verify account was loaded
    const server = getMockServer();
    expect(server.loadAccount).toHaveBeenCalledWith(
      'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
    );

    // Verify TransactionBuilder was created with correct params
    expect(TransactionBuilder).toHaveBeenCalledWith(mockAccount, {
      fee: '100',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    // Verify a payment operation was added
    expect(Operation.payment).toHaveBeenCalledWith({
      destination: 'GBCQV4J5X6K7L8M9N0O1P2Q3R4S5T6U7V8W9X0Y1Z2A3B4C5D6E7F8G9H0I1J2',
      asset: { type: 'native' },
      amount: '1000000',
    });

    // Verify transaction was signed (built.sign(sourceKeypair))
    expect(mockTx.sign).toHaveBeenCalledWith(mockSourceKeypair);
  });

  it('builds a payment with USDC asset and issuer', async () => {
    const mockUsdcAsset = {
      code: 'USDC',
      issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    };

    const result = await buildPaymentTransaction({
      sourceSecret: 'SBSECRET...',
      destination: 'GBCQV4J5X6K7L8M9N0O1P2Q3R4S5T6U7V8W9X0Y1Z2A3B4C5D6E7F8G9H0I1J2',
      amount: '500000',
      asset: 'USDC',
      assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      network: 'testnet',
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });

    expect(result).toHaveProperty('txXdr');
    expect(result).toHaveProperty('txHash');
    expect(Asset.native).not.toHaveBeenCalled();
    expect(Operation.payment).toHaveBeenCalledWith({
      destination: 'GBCQV4J5X6K7L8M9N0O1P2Q3R4S5T6U7V8W9X0Y1Z2A3B4C5D6E7F8G9H0I1J2',
      asset: expect.objectContaining({
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      }),
      amount: '500000',
    });
  });

  it('includes a memo when provided', async () => {
    await buildPaymentTransaction({
      sourceSecret: 'SBSECRET...',
      destination: 'GBCQV4J5X6K7L8M9N0O1P2Q3R4S5T6U7V8W9X0Y1Z2A3B4C5D6E7F8G9H0I1J2',
      amount: '1000000',
      asset: 'XLM',
      memo: 'x402-payment-ref-123',
      network: 'testnet',
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });

    // Verify Memo was added
    expect(Memo).toHaveBeenCalledWith(MemoText, 'x402-payment-ref-123');
  });

  it('throws on unsupported asset without issuer', async () => {
    await expect(
      buildPaymentTransaction({
        sourceSecret: 'SBSECRET...',
        destination: 'GBCQV4J5X6K7L8M9N0O1P2Q3R4S5T6U7V8W9X0Y1Z2A3B4C5D6E7F8G9H0I1J2',
        amount: '1000000',
        asset: 'USDC',
        network: 'testnet',
        horizonUrl: 'https://horizon-testnet.stellar.org',
      }),
    ).rejects.toThrow('Unsupported asset or missing issuer: USDC');
  });

  it('uses mainnet passphrase when network is mainnet', async () => {
    await buildPaymentTransaction({
      sourceSecret: 'SBSECRET...',
      destination: 'GBCQV4J5X6K7L8M9N0O1P2Q3R4S5T6U7V8W9X0Y1Z2A3B4C5D6E7F8G9H0I1J2',
      amount: '1000000',
      asset: 'XLM',
      network: 'mainnet',
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(TransactionBuilder).toHaveBeenCalledWith(expect.anything(), {
      fee: '100',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    });
  });
});

describe('createHorizonServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a testnet Horizon server by default', () => {
    const server = createHorizonServer();
    expect(Horizon.Server).toHaveBeenCalledWith('https://horizon-testnet.stellar.org');
  });

  it('creates a mainnet Horizon server', () => {
    const server = createHorizonServer('mainnet');
    expect(Horizon.Server).toHaveBeenCalledWith('https://horizon.stellar.org');
  });

  it('uses custom URL when provided', () => {
    const server = createHorizonServer('testnet', 'https://custom-horizon.example.com');
    expect(Horizon.Server).toHaveBeenCalledWith('https://custom-horizon.example.com');
  });
});

describe('accountExists', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true when account exists', async () => {
    const mockServer = { loadAccount: jest.fn().mockResolvedValue({}) };
    const result = await accountExists('GA5ZSE6...', mockServer as any);
    expect(result).toBe(true);
    expect(mockServer.loadAccount).toHaveBeenCalledWith('GA5ZSE6...');
  });

  it('returns false when account does not exist', async () => {
    const mockServer = { loadAccount: jest.fn().mockRejectedValue(new Error('not found')) };
    const result = await accountExists('GA5ZSE6...', mockServer as any);
    expect(result).toBe(false);
  });
});

describe('getAccountBalances', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns balances for an existing account', async () => {
    const mockAccount = {
      balances: [
        { asset_type: 'native', balance: '10000.5000000' },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          balance: '5000.0000000',
          asset_issuer: 'GA5ZSE...',
        },
      ],
    };
    const mockServer = { loadAccount: jest.fn().mockResolvedValue(mockAccount) };

    const balances = await getAccountBalances('GA5ZSE6...', mockServer as any);

    expect(balances).toHaveLength(2);
    expect(balances[0]).toEqual({ asset: 'XLM', balance: '10000.5000000', issuer: undefined });
    expect(balances[1]).toEqual({ asset: 'USDC', balance: '5000.0000000', issuer: 'GA5ZSE...' });
  });

  it('returns empty array when account does not exist', async () => {
    const mockServer = { loadAccount: jest.fn().mockRejectedValue(new Error('not found')) };
    const balances = await getAccountBalances('GA5ZSE6...', mockServer as any);
    expect(balances).toEqual([]);
  });
});

describe('getTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns transaction data when found', async () => {
    const mockTxData = { hash: 'abc123', successful: true };
    const mockTransactionsCall = jest.fn().mockResolvedValue(mockTxData);
    const mockTransactions = jest.fn().mockReturnValue({
      transaction: jest.fn().mockReturnValue({
        call: mockTransactionsCall,
      }),
    });

    const mockServer = { transactions: mockTransactions } as any;

    const result = await getTransaction('abc123', mockServer);

    expect(result).toEqual(mockTxData);
    expect(mockTransactions).toHaveBeenCalled();
  });

  it('returns null when transaction is not found', async () => {
    const mockTransactionsCall = jest.fn().mockRejectedValue(new Error('not found'));
    const mockTransactions = jest.fn().mockReturnValue({
      transaction: jest.fn().mockReturnValue({
        call: mockTransactionsCall,
      }),
    });

    const mockServer = { transactions: mockTransactions } as any;

    const result = await getTransaction('abc123', mockServer);
    expect(result).toBeNull();
  });
});

describe('signChallenge and verifyChallenge', () => {
  const mockKeypair = {
    sign: jest.fn(),
    verify: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('signs a challenge string and returns base64 signature', () => {
    const mockSignature = Buffer.from('signed-message-bytes');
    mockKeypair.sign.mockReturnValue(mockSignature);
    (Keypair.fromSecret as jest.Mock).mockReturnValue(mockKeypair);

    const result = signChallenge({
      secretKey: 'SBSECRET...',
      challenge: 'Sign this message to authenticate',
      network: 'testnet',
    });

    expect(result).toBe('c2lnbmVkLW1lc3NhZ2UtYnl0ZXM='); // base64 of 'signed-message-bytes'
    expect(Keypair.fromSecret).toHaveBeenCalledWith('SBSECRET...');
    expect(mockKeypair.sign).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it('verifies a valid signature', () => {
    mockKeypair.verify.mockReturnValue(true);
    (Keypair.fromPublicKey as jest.Mock).mockReturnValue(mockKeypair);

    const result = verifyChallenge(
      'GA5ZSE6...',
      'Sign this message to authenticate',
      'c2lnbmVkLW1lc3NhZ2UtYnl0ZXM=',
    );

    expect(result).toBe(true);
    expect(Keypair.fromPublicKey).toHaveBeenCalledWith('GA5ZSE6...');
    expect(mockKeypair.verify).toHaveBeenCalledWith(expect.any(Buffer), expect.any(Buffer));
  });

  it('rejects an invalid signature', () => {
    mockKeypair.verify.mockReturnValue(false);
    (Keypair.fromPublicKey as jest.Mock).mockReturnValue(mockKeypair);

    const result = verifyChallenge(
      'GA5ZSE6...',
      'Sign this message to authenticate',
      'aW52YWxpZC1zaWc=',
    );

    expect(result).toBe(false);
  });

  it('returns false on verification error (e.g., bad public key)', () => {
    (Keypair.fromPublicKey as jest.Mock).mockImplementation(() => {
      throw new Error('Invalid public key');
    });

    const result = verifyChallenge('INVALID...', 'test', 'dGVzdA==');

    expect(result).toBe(false);
  });
});
