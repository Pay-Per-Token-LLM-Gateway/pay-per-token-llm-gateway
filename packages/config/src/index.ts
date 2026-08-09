// ──────────────────────────────────────────────
// @x402/config — Centralized configuration
// ──────────────────────────────────────────────

import type { StellarNetwork, PaymentAsset } from '@x402/types';

/** Circle USDC issuer on Stellar testnet */
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** Circle USDC issuer on Stellar mainnet */
const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** Futurenet USDC issuer (same as testnet for sandbox purposes) */
const FUTURENET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

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
  };
}

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

  // JWT_SECRET is required in production; in dev/test, a warning is sufficient
  if (!process.env.JWT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'JWT_SECRET is required in production. Generate one with: openssl rand -base64 32',
      );
    }
    console.warn(
      '⚠  JWT_SECRET not set — using insecure dev default. Set JWT_SECRET before deploying to production.',
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
    { horizon: string; rpc: string; passphrase: string; usdcIssuer: string }
  > = {
    testnet: {
      horizon: 'https://horizon-testnet.stellar.org',
      rpc: 'https://soroban-testnet.stellar.org',
      passphrase: 'Test SDF Network ; September 2015',
      usdcIssuer: TESTNET_USDC_ISSUER,
    },
    mainnet: {
      horizon: 'https://horizon.stellar.org',
      rpc: 'https://soroban-mainnet.stellar.org',
      passphrase: 'Public Global Stellar Network ; September 2015',
      usdcIssuer: MAINNET_USDC_ISSUER,
    },
    futurenet: {
      horizon: 'https://horizon-futurenet.stellar.org',
      rpc: 'https://rpc-futurenet.stellar.org',
      passphrase: 'Test SDF Future Network ; October 2022',
      usdcIssuer: FUTURENET_USDC_ISSUER,
    },
  };

  // Determine JWT secret — required in production, dev fallback only in non-prod
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret && nodeEnv === 'production') {
    throw new Error('JWT_SECRET is required in production');
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
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
        process.env.USDC_ISSUER || networkConfigs[network].usdcIssuer,
      quoteExpirySeconds: parseInt(process.env.QUOTE_EXPIRY_SECONDS || '300', 10),
      minPaymentAmount: process.env.MIN_PAYMENT_AMOUNT || '10000', // 0.00001 XLM in stroops
      contractAdminSecret: process.env.CONTRACT_ADMIN_SECRET || undefined,
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
      jwtSecret: jwtSecret || 'dev-secret-change-in-production',
      sessionDuration: parseInt(process.env.SESSION_DURATION || '86400', 10),
      corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3001').split(','),
    },

    contracts: {
      paymentVerifier:
        process.env.PAYMENT_VERIFIER_CONTRACT ||
        'CDHGI3A2BXRC5AQDPWEEXUDQMDXTDZYBCLJZWSE5XZKMVEGJ5LLHA4CZ',
      creditEscrow:
        process.env.CREDIT_ESCROW_CONTRACT ||
        'CCE7AWVXPO57W5KDONOPMHDV4S5UBUBMHNJVSAVPL7AZGMD4WQN6WVAP',
      multisig:
        process.env.MULTISIG_CONTRACT ||
        'CDMBVMMNJVAJVAV3T2TAL2TAACGTKYUS45RXNLCYKYUC3VGHBI66NWAA',
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
