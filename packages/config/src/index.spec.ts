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

    it('accepts a real secret and reads AUTH_DEV_MODE / TRUST_PROXY from the environment', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.AUTH_DEV_MODE = 'true';
      process.env.TRUST_PROXY = 'loopback';

      const config = loadConfig();
      expect(config.security.jwtSecret).toBe('a-real-random-256-bit-secret');
      expect(config.security.authDevMode).toBe(true);
      expect(config.security.trustProxy).toBe('loopback');
    });

    it('defaults authDevMode to false and trustProxy to "1"', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      delete process.env.AUTH_DEV_MODE;
      delete process.env.TRUST_PROXY;

      const config = loadConfig();
      expect(config.security.authDevMode).toBe(false);
      expect(config.security.trustProxy).toBe('1');
    });

    it('defaults minPaymentAmount to 10000 stroops when the env var is not set', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      delete process.env.MIN_PAYMENT_AMOUNT;

      const config = loadConfig();
      expect(config.payment.minPaymentAmount).toBe('10000');
    });

    it('reads MIN_PAYMENT_AMOUNT from the environment', () => {
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'a-real-random-256-bit-secret';
      process.env.MIN_PAYMENT_AMOUNT = '50000';

      const config = loadConfig();
      expect(config.payment.minPaymentAmount).toBe('50000');
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
