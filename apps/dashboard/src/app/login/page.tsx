'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wallet, ArrowRight, Shield, Loader2, AlertTriangle } from 'lucide-react';
import { requestChallenge, verifyChallenge, setSessionToken, setWalletAddress } from '@/lib/api';

type WalletType = 'freighter' | 'xbull' | 'albedo';

interface WalletInfo {
  name: string;
  icon: typeof Wallet;
  color: string;
  type: WalletType;
}

const wallets: WalletInfo[] = [
  {
    name: 'Freighter',
    icon: Wallet,
    color: 'from-green-500 to-emerald-600',
    type: 'freighter',
  },
  {
    name: 'xBull',
    icon: Shield,
    color: 'from-blue-500 to-purple-600',
    type: 'xbull',
  },
  {
    name: 'Albedo',
    icon: Wallet,
    color: 'from-yellow-500 to-orange-600',
    type: 'albedo',
  },
];

export default function LoginPage() {
  const router = useRouter();
  const [connecting, setConnecting] = useState<WalletType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'select' | 'signing' | 'verifying'>('select');

  const handleConnect = async (walletInfo: WalletInfo) => {
    setConnecting(walletInfo.type);
    setError(null);

    try {
      // Step 1: Get wallet public key from the extension
      setStep('signing');
      const address = await getWalletAddress(walletInfo.type);
      if (!address) {
        throw new Error(`${walletInfo.name} wallet not found. Please install it and try again.`);
      }

      // Step 2: Request a challenge from the gateway
      const { challengeId, challenge } = await requestChallenge(address);

      // Step 3: Sign the challenge with the wallet
      const signature = await signChallenge(walletInfo.type, address, challenge);

      // Step 4: Verify with the gateway.
      // The gateway sets an httpOnly cookie (primary auth) and also returns
      // the token for in-memory cross-origin fallback (Vercel → localhost).
      setStep('verifying');
      const { token } = await verifyChallenge(challengeId, address, signature);

      // Step 5: Store in-memory token (cross-origin fallback) + wallet address
      if (token) setSessionToken(token);
      setWalletAddress(address);

      router.push('/');
    } catch (err) {
      setError((err as Error).message);
      setStep('select');
    } finally {
      setConnecting(null);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/icon.svg"
            alt="x402 Logo"
            className="w-20 h-20 mx-auto mb-4 rounded-2xl shadow-xl shadow-green-500/20"
          />
          <h1 className="text-2xl font-bold">x402 Gateway</h1>
          <p className="text-muted-foreground mt-2">
            Connect your Stellar wallet to manage your LLM endpoints
          </p>
        </div>

        {error && (
          <div className="card border-red-300/60 bg-red-50 dark:border-red-800/30 dark:bg-red-950/10 mb-4">
            <div className="flex items-start gap-3">
              <div className="p-1.5 bg-red-100 dark:bg-red-900/20 rounded-lg shrink-0">
                <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                <button
                  onClick={() => {
                    setError(null);
                    setStep('select');
                  }}
                  className="text-xs text-green-600 dark:text-green-400 hover:underline mt-1"
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 'verifying' && (
          <div className="card mb-4">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-green-600 dark:text-green-400 animate-spin" />
              <div>
                <p className="text-sm font-medium">Verifying signature...</p>
                <p className="text-xs text-muted-foreground">Confirming with the gateway</p>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-3">
          {wallets.map((wallet) => (
            <button
              key={wallet.type}
              onClick={() => handleConnect(wallet)}
              disabled={connecting !== null}
              className="w-full flex items-center justify-between p-4 bg-card border border-border rounded-xl hover:border-green-600/60 dark:hover:border-green-800/50 transition-all disabled:opacity-50 group"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-lg bg-gradient-to-br ${wallet.color} flex items-center justify-center`}
                >
                  {connecting === wallet.type ? (
                    <Loader2 className="w-5 h-5 text-white animate-spin" />
                  ) : (
                    <wallet.icon className="w-5 h-5 text-white" />
                  )}
                </div>
                <div className="text-left">
                  <span className="font-medium">{wallet.name}</span>
                  <p className="text-xs text-muted-foreground">Stellar browser wallet</p>
                </div>
              </div>
              <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-green-400 transition-colors" />
            </button>
          ))}
        </div>

        <p className="text-xs text-muted-foreground text-center mt-6">
          Don&apos;t have a wallet?{' '}
          <a
            href="https://freighter.app"
            target="_blank"
            className="text-green-600 dark:text-green-400 hover:underline"
          >
            Install Freighter
          </a>
        </p>
      </div>
    </div>
  );
}

// ── Wallet Helpers ───────────────────────────

/**
 * Get the public key from a Stellar browser wallet extension.
 * In production, this uses the wallet's browser API.
 * Falls back to a development mode address if no extension is detected.
 */
async function getWalletAddress(type: WalletType): Promise<string | null> {
  try {
    // Try browser wallet extension APIs
    if (type === 'freighter' && window.freighterApi) {
      const pubKey = await window.freighterApi.getPublicKey();
      return pubKey;
    }

    if (type === 'xbull' && window.xBullSDK) {
      const pubKey = await window.xBullSDK.getPublicKey();
      return pubKey;
    }

    if (type === 'albedo' && window.albedo) {
      const pubKey = await window.albedo.publicKey();
      return pubKey;
    }

    // Dev fallback: use a throwaway testnet address when no wallet extension
    // is detected. Enabled in local dev (NODE_ENV=development) OR when
    // NEXT_PUBLIC_AUTH_DEV_MODE=true (Vercel test deployments). The gateway
    // also requires AUTH_DEV_MODE=true to accept dev signatures.
    if (
      process.env.NODE_ENV === 'development' ||
      process.env.NEXT_PUBLIC_AUTH_DEV_MODE === 'true'
    ) {
      console.warn(`[x402] No ${type} wallet extension detected. Using dev mode address.`);
      return 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Sign a challenge string with a Stellar wallet.
 */
async function signChallenge(
  type: WalletType,
  address: string,
  challenge: string,
): Promise<string> {
  try {
    if (type === 'freighter' && window.freighterApi) {
      return await window.freighterApi.signMessage(address, challenge);
    }

    if (type === 'xbull' && window.xBullSDK) {
      return await window.xBullSDK.signMessage(address, challenge);
    }

    if (type === 'albedo' && window.albedo) {
      const result = await window.albedo.signMessage(challenge);
      return result.signature;
    }

    // Dev fallback: return a mock signature when no wallet extension is
    // detected. Enabled in local dev OR when NEXT_PUBLIC_AUTH_DEV_MODE=true.
    if (
      process.env.NODE_ENV === 'development' ||
      process.env.NEXT_PUBLIC_AUTH_DEV_MODE === 'true'
    ) {
      console.warn(`[x402] No ${type} wallet for signing. Using dev mode signature.`);
      return Buffer.from(`dev-sig-${address}-${Date.now()}`, 'utf-8').toString('base64');
    }

    throw new Error(
      `No ${type} wallet detected. Please install the ${type} browser extension to sign in.`,
    );
  } catch (err) {
    throw new Error(`Failed to sign with ${type}: ${(err as Error).message}`);
  }
}

// ── Wallet API Type Declarations ─────────────

declare global {
  interface Window {
    freighterApi?: {
      getPublicKey: () => Promise<string>;
      signMessage: (address: string, message: string) => Promise<string>;
    };
    xBullSDK?: {
      getPublicKey: () => Promise<string>;
      signMessage: (address: string, message: string) => Promise<string>;
    };
    albedo?: {
      publicKey: () => Promise<string>;
      signMessage: (message: string) => Promise<{ signature: string }>;
    };
  }
}
