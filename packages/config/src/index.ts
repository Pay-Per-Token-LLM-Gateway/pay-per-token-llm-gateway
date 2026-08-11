// ──────────────────────────────────────────────
// @x402/config — Centralized configuration
// ──────────────────────────────────────────────

import type { StellarNetwork, PaymentAsset } from '@x402/types';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { config as loadDotEnv } from 'dotenv';

// Load `.env` from the process working directory (the repo root for the
// documented `pnpm dev:gateway` / `pnpm start:gateway` flow) so that
// `cp .env.example .env` works out of the box. This must run before any
// `process.env` reads below.
//
// - Never overrides variables that are already set in the environment
//   (Docker, Railway, CI, shell exports all take precedence).
// - Silent no-op when `.env` does not exist (e.g. CI, tests, containers
//   that inject env vars directly).
const envFilePath = resolve(process.cwd(), '.env');
if (existsSync(envFilePath)) {
  loadDotEnv({ path: envFilePath });
}

export interface ContractAddresses {
  /** Payment verifier contract ID */
  paymentVerifier: string;
  /** Credit escrow contract ID (v2) */
  creditEscrow: string;
  /** Multisig wallet contract ID */
  multisig: string;
}

export interface GatewayConfig {
  /** Server port */
  port: number;
  /** Server host */
  host: string;
  /**
   * Public base URL of the gateway (e.g. https://x402-gateway.example.com).
   * Used in payment quotes/instructions so clients receive usable links even
   * when the server binds 0.0.0.0. Falls back to host:port for local dev.
   */
  publicBaseUrl?: string;
  /** Node environment */
  nodeEnv: 'development' | 'production' | 'test';

  /** Stellar configuration */
  stellar: {
    /** Network to use */
    network: StellarNetwork;
    /** Horizon server URL */
    horizonUrl: string;
    /** Soroban RPC URL */
    sorobanRpcUrl: string;
    /** Network passphrase */
    networkPassphrase: string;
  };

  /** Database */
  database: {
    url: string;
  };

  /** Redis */
  redis: {
    url: string;
    /** Payment verification cache TTL (seconds) */
    paymentCacheTtl: number;
    /** Rate limit window (seconds) */
    rateLimitWindow: number;
    /** Max unpaid requests per window */
    rateLimitMax: number;
  };

  /** Default payment configuration */
  payment: {
    /** Default asset for payments */
    defaultAsset: PaymentAsset;
    /** USDC issuer address */
    usdcIssuer: string;
    /** Quote expiry time (seconds) */
    quoteExpirySeconds: number;
    /** Minimum payment amount in stroops (smallest unit) */
    minPaymentAmount: string;
    /** Secret key of the contract admin (for on-chain payment recording).
     * Optional — if not set, on-chain recording is skipped. */
    contractAdminSecret?: string;
    /**
     * Opt-in per-token on-chain settlement via the credit-escrow contract:
     * after each metered LLM response the gateway charges the actual cost from
     * the caller's escrow balance and auto-refunds any surplus. Requires
     * `CONTRACT_ADMIN_SECRET` and an escrow contract funded by deposits.
     */
    escrowSettlementEnabled: boolean;
  };

  /** Deployed Soroban contract addresses */
  contracts: ContractAddresses;

  /** Upstream LLM configuration */
  llm: {
    /** Request timeout for non-streaming requests (ms) */
    requestTimeout: number;
    /** Timeout for streaming requests (ms). Defaults to 10 minutes. */
    streamTimeout?: number;
    /** Max retries for failed upstream calls */
    maxRetries: number;
  };

  /** Notification configuration */
  notifications: {
    email: {
      enabled: boolean;
      smtpHost?: string;
      smtpPort?: number;
      fromAddress?: string;
    };
    webhook: {
      enabled: boolean;
      retryCount: number;
      retryDelayMs: number;
    };
  };

  /** Security */
  security: {
    /** JWT secret for dashboard sessions */
    jwtSecret: string;
    /** Session duration (seconds) */
    sessionDuration: number;
    /** CORS origins */
    corsOrigins: string[];
    /**
     * Explicit opt-in for the dev-only auth bypass (accepts `dev-sig-`
     * signatures, authenticating as any wallet). Never implied by NODE_ENV —
     * set AUTH_DEV_MODE=true in local development only.
     */
    authDevMode: boolean;
    /**
     * Express `trust proxy` setting, used to resolve the real client IP
     * behind Cloudflare/NGINX/Railway for IP-based rate limiting.
     * Examples: "1" (default, trust first hop), "loopback", or a
     * comma-separated list of proxy IPs.
     */
    trustProxy: string;
    /** When true, new providers start inactive and require admin approval. */
    providerApprovalRequired: boolean;
  };
}

/**
 * Well-known placeholder JWT secrets that must never be used in a running
 * deployment. If the operator copied .env.example without generating a real
 * secret, the gateway fails fast instead of running with a forgeable secret.
 */
const INSECURE_JWT_SECRETS = [
  'change-me-to-a-random-64-byte-hex-string',
  'change-me-in-production',
  'dev-secret-change-in-production',
];

/**
 * Validate that required environment variables are set.
 * Call this at startup to fail fast with clear error messages.
 */
export function validateEnv(): void {
  // Skip validation in test mode — test suites set their own env vars
  if (process.env.NODE_ENV === 'test') return;

  const required: { key: string; value: string | undefined; message: string }[] = [
    {
      key: 'DATABASE_URL',
      value: process.env.DATABASE_URL,
      message: 'DATABASE_URL is required. Set it to your PostgreSQL connection string.',
    },
    {
      key: 'REDIS_URL',
      value: process.env.REDIS_URL,
      message: 'REDIS_URL is required. Set it to your Redis connection string.',
    },
  ];

  // JWT_SECRET is required in every non-test environment. Without it the
  // gateway would fall back to a known default secret, letting anyone forge
  // session tokens — fail fast instead. (Test suites set their own secret.)
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required. Generate one with: openssl rand -base64 32');
  }
  if (INSECURE_JWT_SECRETS.includes(process.env.JWT_SECRET)) {
    throw new Error(
      'JWT_SECRET is set to a known insecure placeholder. Generate a real secret with: openssl rand -base64 32',
    );
  }

  const missing = required.filter((r) => !r.value);
  if (missing.length > 0) {
    const messages = missing.map((r) => `  • ${r.message}`).join('\n');
    throw new Error(`Missing required environment variables:\n${messages}`);
  }
}

/**
 * Load configuration from environment variables with sane defaults.
 */
export function loadConfig(): GatewayConfig {
  const nodeEnv = (process.env.NODE_ENV as GatewayConfig['nodeEnv']) || 'development';
  const network = (process.env.STELLAR_NETWORK as StellarNetwork) || 'testnet';

  const networkConfigs: Record<
    StellarNetwork,
    { horizon: string; rpc: string; passphrase: string }
  > = {
    testnet: {
      horizon: 'https://horizon-testnet.stellar.org',
      rpc: 'https://soroban-testnet.stellar.org',
      passphrase: 'Test SDF Network ; September 2015',
    },
    mainnet: {
      horizon: 'https://horizon.stellar.org',
      rpc: 'https://soroban-mainnet.stellar.org',
      passphrase: 'Public Global Stellar Network ; September 2015',
    },
    futurenet: {
      horizon: 'https://horizon-futurenet.stellar.org',
      rpc: 'https://rpc-futurenet.stellar.org',
      passphrase: 'Test SDF Future Network ; October 2022',
    },
  };

  // JWT_SECRET is required in every non-test environment (fail fast so a
  // misconfigured deploy can never silently run with a known default secret).
  const jwtSecret = process.env.JWT_SECRET;
  if (nodeEnv !== 'test') {
    if (!jwtSecret) {
      throw new Error(
        'JWT_SECRET is required (set it to a random 256-bit value; generate with: openssl rand -base64 32)',
      );
    }
    if (INSECURE_JWT_SECRETS.includes(jwtSecret)) {
      throw new Error(
        'JWT_SECRET is set to a known insecure placeholder. Generate a real secret with: openssl rand -base64 32',
      );
    }
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    publicBaseUrl: process.env.PUBLIC_GATEWAY_URL || undefined,
    nodeEnv,

    stellar: {
      network,
      horizonUrl: process.env.HORIZON_URL || networkConfigs[network].horizon,
      sorobanRpcUrl: process.env.SOROBAN_RPC_URL || networkConfigs[network].rpc,
      networkPassphrase: networkConfigs[network].passphrase,
    },

    database: {
      url: process.env.DATABASE_URL || 'postgresql://localhost:5432/x402_gateway',
    },

    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      paymentCacheTtl: parseInt(process.env.PAYMENT_CACHE_TTL || '3600', 10),
      rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60', 10),
      rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
    },

    payment: {
      defaultAsset: 'USDC',
      usdcIssuer:
        process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      quoteExpirySeconds: parseInt(process.env.QUOTE_EXPIRY_SECONDS || '300', 10),
      minPaymentAmount: process.env.MIN_PAYMENT_AMOUNT || '10000', // 0.00001 XLM in stroops
      contractAdminSecret: process.env.CONTRACT_ADMIN_SECRET || undefined,
      escrowSettlementEnabled: process.env.ESCROW_SETTLEMENT_ENABLED === 'true',
    },

    llm: {
      requestTimeout: parseInt(process.env.LLM_REQUEST_TIMEOUT || '120000', 10),
      streamTimeout: process.env.LLM_STREAM_TIMEOUT
        ? parseInt(process.env.LLM_STREAM_TIMEOUT, 10)
        : undefined,
      maxRetries: parseInt(process.env.LLM_MAX_RETRIES || '2', 10),
    },

    notifications: {
      email: {
        enabled: process.env.EMAIL_ENABLED === 'true',
        smtpHost: process.env.SMTP_HOST,
        smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
        fromAddress: process.env.EMAIL_FROM,
      },
      webhook: {
        enabled: process.env.WEBHOOK_ENABLED !== 'false',
        retryCount: parseInt(process.env.WEBHOOK_RETRY_COUNT || '3', 10),
        retryDelayMs: parseInt(process.env.WEBHOOK_RETRY_DELAY || '1000', 10),
      },
    },

    security: {
      // Test-only fallback; non-test environments throw above when unset.
      jwtSecret: jwtSecret || 'test-secret-not-for-production',
      sessionDuration: parseInt(process.env.SESSION_DURATION || '86400', 10),
      corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3001').split(','),
      authDevMode: process.env.AUTH_DEV_MODE === 'true',
      trustProxy: process.env.TRUST_PROXY || '1',
      providerApprovalRequired: process.env.PROVIDER_APPROVAL_REQUIRED === 'true',
    },

    contracts: {
      paymentVerifier:
        process.env.PAYMENT_VERIFIER_CONTRACT ||
        'CDHGI3A2BXRC5AQDPWEEXUDQMDXTDZYBCLJZWSE5XZKMVEGJ5LLHA4CZ',
      creditEscrow:
        process.env.CREDIT_ESCROW_CONTRACT ||
        'CCE7AWVXPO57W5KDONOPMHDV4S5UBUBMHNJVSAVPL7AZGMD4WQN6WVAP',
      multisig:
        process.env.MULTISIG_CONTRACT || 'CDMBVMMNJVAJVAV3T2TAL2TAACGTKYUS45RXNLCYKYUC3VGHBI66NWAA',
    },
  };
}

/** Shared singleton config instance */
let _config: GatewayConfig | null = null;

export function getConfig(): GatewayConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function setConfig(config: GatewayConfig): void {
  _config = config;
}
