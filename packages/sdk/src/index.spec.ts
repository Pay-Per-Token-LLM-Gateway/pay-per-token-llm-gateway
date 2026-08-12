import { X402Client } from './index';
import * as wallet from '@x402/wallet';
import { Quote } from '@x402/types';

jest.mock('@x402/wallet');
jest.mock('@x402/logger');

describe('X402Client', () => {
  let client: X402Client;
  const mockConfig = {
    gatewayUrl: 'https://gateway.example.com',
    network: 'testnet' as const,
  };

  const mockQuote: Quote = {
    id: 'quote-123',
    route: '/v1/chat/completions',
    pricingModel: 'flat',
    amount: '10000000', // 1 USDC
    asset: 'USDC',
    assetIssuer: 'G...',
    paymentAddress: 'G_PAYMENT',
    memo: 'memo123',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    network: 'testnet',
    statusUrl: 'https://gateway.example.com/status/quote-123',
  };

  beforeEach(() => {
    client = new X402Client(mockConfig);
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  describe('executePayment', () => {
    it('should fail if neither secretKey nor signTransaction is provided', async () => {
      const result = await (client as any).executePayment(mockQuote);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Payment required');
    });

    it('should pay using secretKey when provided', async () => {
      const clientWithKey = new X402Client({ ...mockConfig, secretKey: 'S123' });
      (wallet.buildPaymentTransaction as jest.Mock).mockResolvedValue({
        txXdr: 'signed-xdr',
        txHash: 'tx-hash-123',
      });
      (wallet.createHorizonServer as jest.Mock).mockReturnValue({
        submitTransaction: jest.fn().mockResolvedValue({}),
      });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ successful: true }),
      });

      const result = await (clientWithKey as any).executePayment(mockQuote);
      expect(result.success).toBe(true);
      expect(result.txHash).toBe('tx-hash-123');
      expect(wallet.buildPaymentTransaction).toHaveBeenCalled();
    });

    it('should pay using external signer when signTransaction is provided', async () => {
      const signTransaction = jest.fn().mockResolvedValue('externally-signed-xdr');
      const clientWithExternal = new X402Client({
        ...mockConfig,
        publicKey: 'G_SOURCE',
        signTransaction,
      });

      (wallet.buildUnsignedPaymentTransaction as jest.Mock).mockResolvedValue({
        txXdr: 'unsigned-xdr',
        txHash: 'tx-hash-external',
      });
      (wallet.createHorizonServer as jest.Mock).mockReturnValue({
        submitTransaction: jest.fn().mockResolvedValue({}),
      });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ successful: true }),
      });

      const result = await (clientWithExternal as any).executePayment(mockQuote);

      expect(result.success).toBe(true);
      expect(result.txHash).toBe('tx-hash-external');
      expect(wallet.buildUnsignedPaymentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePublicKey: 'G_SOURCE',
        }),
      );
      expect(signTransaction).toHaveBeenCalledWith('unsigned-xdr');
    });

    it('should fail if publicKey is missing for external signer', async () => {
      const clientWithExternalNoPub = new X402Client({
        ...mockConfig,
        signTransaction: jest.fn(),
      });

      const result = await (clientWithExternalNoPub as any).executePayment(mockQuote);
      expect(result.success).toBe(false);
      expect(result.error).toContain('publicKey is required');
    });

    it('should handle external signer rejection', async () => {
      const signTransaction = jest.fn().mockRejectedValue(new Error('User rejected'));
      const clientWithExternal = new X402Client({
        ...mockConfig,
        publicKey: 'G_SOURCE',
        signTransaction,
      });

      (wallet.buildUnsignedPaymentTransaction as jest.Mock).mockResolvedValue({
        txXdr: 'unsigned-xdr',
        txHash: 'tx-hash-external',
      });

      const result = await (clientWithExternal as any).executePayment(mockQuote);
      expect(result.success).toBe(false);
      expect(result.error).toContain('User rejected');
    });
  });
});
