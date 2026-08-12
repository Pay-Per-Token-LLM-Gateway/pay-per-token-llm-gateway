// Tests for the config security hardening (H3): JWT_SECRET is required in
// every non-test environment, known placeholder secrets are rejected, and the
// explicit AUTH_DEV_MODE / TRUST_PROXY switches are read from the environment.

import { loadConfig, validateEnv, getConfig, setConfig } from './index';

describe('config security hardening', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('loadConfig', () => {
    it('throws when JWT_SECRET is missing in a non-test environment', () => {
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'development';

      expect(() => loadConfig()).toThrow(/JWT_SECRET/);
    });

    it('throws when JWT_SECRET is missing in production', () => {
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'production';

      expect(() => loadConfig()).toThrow(/JWT_SECRET/);
    });

    it('rejects known insecure placeholder secrets', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'change-me-to-a-random-64-byte-hex-string';

      expect(() => loadConfig()).toThrow(/JWT_SECRET/);
    });

    it('rejects the old hardcoded dev default', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'dev-secret-change-in-production';

      expect(() => loadConfig()).toThrow(/JWT_SECRET/);
    });

    it('allows a missing JWT_SECRET in test mode (test suites set their own)', () => {
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'test';

      expect(() => loadConfig()).not.toThrow();
    });

    it('accepts a real secret and reads AUTH_DEV_MODE / TRUST_PROXY / RATE_LIMIT_BY_WALLET from the environment', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.AUTH_DEV_MODE = 'true';
      process.env.TRUST_PROXY = 'loopback';
      process.env.RATE_LIMIT_BY_WALLET = 'true';

      const config = loadConfig();
      expect(config.security.jwtSecret).toBe('a-real-random-256-bit-secret');
      expect(config.security.authDevMode).toBe(true);
      expect(config.security.trustProxy).toBe('loopback');
      expect(config.security.rateLimitByWallet).toBe(true);
    });

    it('defaults authDevMode to false, trustProxy to "1", and rateLimitByWallet to false', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      delete process.env.AUTH_DEV_MODE;
      delete process.env.TRUST_PROXY;
      delete process.env.RATE_LIMIT_BY_WALLET;

      const config = loadConfig();
      expect(config.security.authDevMode).toBe(false);
      expect(config.security.trustProxy).toBe('1');
      expect(config.security.rateLimitByWallet).toBe(false);
    });

    it('caches the config singleton via getConfig and replaces it via setConfig', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      delete process.env.AUTH_DEV_MODE;
      delete process.env.TRUST_PROXY;

      const first = getConfig();
      const second = getConfig();
      expect(second).toBe(first); // cached singleton

      const modified = { ...first, security: { ...first.security, trustProxy: 'loopback' } };
      setConfig(modified);
      expect(getConfig()).toBe(modified);
    });
  });

  describe('Stellar network presets', () => {
    const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

    it('defaults to testnet endpoints and the testnet USDC issuer when STELLAR_NETWORK is unset', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      delete process.env.STELLAR_NETWORK;
      delete process.env.USDC_ISSUER;
      delete process.env.HORIZON_URL;
      delete process.env.SOROBAN_RPC_URL;

      const config = loadConfig();
      expect(config.stellar.network).toBe('testnet');
      expect(config.stellar.horizonUrl).toBe('https://horizon-testnet.stellar.org');
      expect(config.stellar.sorobanRpcUrl).toBe('https://soroban-testnet.stellar.org');
      expect(config.stellar.networkPassphrase).toBe('Test SDF Network ; September 2015');
      expect(config.payment.usdcIssuer).toBe(TESTNET_USDC_ISSUER);
    });

    it('loads mainnet endpoints, passphrase, and the mainnet USDC issuer when STELLAR_NETWORK=mainnet', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.STELLAR_NETWORK = 'mainnet';
      delete process.env.USDC_ISSUER;
      delete process.env.HORIZON_URL;
      delete process.env.SOROBAN_RPC_URL;

      const config = loadConfig();
      expect(config.stellar.network).toBe('mainnet');
      expect(config.stellar.horizonUrl).toBe('https://horizon.stellar.org');
      expect(config.stellar.sorobanRpcUrl).toBe('https://soroban-mainnet.stellar.org');
      expect(config.stellar.networkPassphrase).toBe(
        'Public Global Stellar Network ; September 2015',
      );
      expect(config.payment.usdcIssuer).toBe(MAINNET_USDC_ISSUER);
    });

    it('keeps the testnet USDC issuer on futurenet', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.STELLAR_NETWORK = 'futurenet';
      delete process.env.USDC_ISSUER;

      const config = loadConfig();
      expect(config.payment.usdcIssuer).toBe(TESTNET_USDC_ISSUER);
    });

    it('lets an explicit USDC_ISSUER env var override the network default', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.STELLAR_NETWORK = 'mainnet';
      process.env.USDC_ISSUER = 'GCUSTOMISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      const config = loadConfig();
      expect(config.payment.usdcIssuer).toBe('GCUSTOMISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
      // The network preset itself is still mainnet.
      expect(config.stellar.network).toBe('mainnet');
    });
  });

  describe('validateEnv', () => {
    it('throws when JWT_SECRET is missing outside of test', () => {
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'development';
      process.env.DATABASE_URL = 'postgres://localhost:5432/db';
      process.env.REDIS_URL = 'redis://localhost:6379';

      expect(() => validateEnv()).toThrow(/JWT_SECRET/);
    });

    it('throws for placeholder secrets', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'change-me-in-production';
      process.env.DATABASE_URL = 'postgres://localhost:5432/db';
      process.env.REDIS_URL = 'redis://localhost:6379';

      expect(() => validateEnv()).toThrow(/JWT_SECRET/);
    });

    it('skips validation entirely in test mode', () => {
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'test';

      expect(() => validateEnv()).not.toThrow();
    });
  });
});
