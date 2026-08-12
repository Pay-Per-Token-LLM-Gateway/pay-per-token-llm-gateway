/** @jest-environment node */

import { getDevWalletAddress, isDevModeActive, isDevModeAllowed, type DevModeEnv } from './devMode';

const DEV_WALLET = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';

function env(overrides: Partial<DevModeEnv> = {}): DevModeEnv {
  return { NODE_ENV: 'development', ...overrides };
}

describe('dev-mode wallet fallback (issue #80)', () => {
  describe('isDevModeAllowed', () => {
    it('allows the fallback in development builds', () => {
      expect(isDevModeAllowed(env())).toBe(true);
    });

    it('denies the fallback in production by default', () => {
      expect(isDevModeAllowed(env({ NODE_ENV: 'production' }))).toBe(false);
    });

    it('allows the fallback in production only behind the explicit opt-in', () => {
      expect(
        isDevModeAllowed(env({ NODE_ENV: 'production', NEXT_PUBLIC_AUTH_DEV_MODE: 'true' })),
      ).toBe(true);
    });
  });

  describe('getDevWalletAddress', () => {
    it('returns the configured address in development', () => {
      expect(getDevWalletAddress(env({ NEXT_PUBLIC_DEV_WALLET: DEV_WALLET }))).toBe(DEV_WALLET);
    });

    it('fails closed in production even when NEXT_PUBLIC_DEV_WALLET is set', () => {
      expect(
        getDevWalletAddress(env({ NODE_ENV: 'production', NEXT_PUBLIC_DEV_WALLET: DEV_WALLET })),
      ).toBeNull();
    });

    it('returns null when no NEXT_PUBLIC_DEV_WALLET is configured', () => {
      expect(getDevWalletAddress(env())).toBeNull();
    });

    it('returns the configured address in production behind the explicit opt-in', () => {
      expect(
        getDevWalletAddress(
          env({
            NODE_ENV: 'production',
            NEXT_PUBLIC_AUTH_DEV_MODE: 'true',
            NEXT_PUBLIC_DEV_WALLET: DEV_WALLET,
          }),
        ),
      ).toBe(DEV_WALLET);
    });
  });

  describe('isDevModeActive', () => {
    it('is active when the fallback is armed', () => {
      expect(isDevModeActive(env({ NEXT_PUBLIC_DEV_WALLET: DEV_WALLET }))).toBe(true);
    });

    it('is inactive in production without the explicit opt-in', () => {
      expect(
        isDevModeActive(env({ NODE_ENV: 'production', NEXT_PUBLIC_DEV_WALLET: DEV_WALLET })),
      ).toBe(false);
    });
  });
});
