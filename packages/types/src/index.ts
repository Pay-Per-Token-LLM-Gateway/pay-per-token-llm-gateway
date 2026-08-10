// ──────────────────────────────────────────────
// @x402/types — Shared TypeScript type definitions
// ──────────────────────────────────────────────

// ── Stellar / Payment Types ─────────────────

/** Supported Stellar networks */
export type StellarNetwork = 'testnet' | 'mainnet' | 'futurenet';

/** Supported payment assets */
export type PaymentAsset = 'USDC' | 'XLM';

/** Stellar asset identifier (canonical form: "USDC:GA5ZSE...") */
export interface AssetIdentifier {
  code: PaymentAsset;
  issuer: string;
}

/** Stellar account / public key */
export type StellarAddress = string;

/** Transaction hash on Stellar */
export type TxHash = string;

// ── x402 Protocol Types ──────────────────────

/** Payment status for a request */
export type PaymentStatus = 'pending' | 'confirmed' | 'failed' | 'refunded' | 'expired';

/** Pricing model for a route */
export type PricingModel = 'flat' | 'per_token';

/** A price quote returned in a 402 response */
export interface Quote {
  /** Unique quote ID (UUID) */
  id: string;
  /** The route/model being requested */
  route: string;
  /** The pricing model used */
  pricingModel: PricingModel;
  /** Price in the asset's smallest unit (e.g., stroops for XLM, 1e-7 for USDC) */
  amount: string;
  /** Payment asset required */
  asset: PaymentAsset;
  /** Stellar asset issuer (for USDC) */
  assetIssuer?: string;
  /** Destination Stellar address for payment */
  paymentAddress: StellarAddress;
  /** Memo required for the payment (if any) */
  memo?: string;
  /** Unix timestamp when this quote expires */
  expiresAt: number;
  /** Chain ID / network passphrase */
  network: StellarNetwork;
  /** URL to check payment status */
  statusUrl: string;
  /** For per-token pricing: estimated max tokens this quote covers */
  estimatedMaxTokens?: number;
  /** For per-token pricing: price per token in smallest unit */
  perTokenPrice?: string;
}

/** Payment verification result from the gateway */
export interface PaymentVerification {
  /** Whether the payment was verified */
  verified: boolean;
  /** Transaction hash on chain */
  txHash: TxHash;
  /** Payer Stellar address */
  payerAddress: StellarAddress;
  /** Amount paid (in smallest unit) */
  amount: string;
  /** Asset of the payment */
  asset: PaymentAsset;
  /** Block/ledger number */
  ledger: number;
  /** Unix timestamp of the block */
  timestamp: number;
  /** Reason for failure (if not verified) */
  failureReason?: string;
}

/** A payment receipt issued after verification */
export interface PaymentReceipt {
  /** Receipt ID */
  id: string;
  /** Original quote ID */
  quoteId: string;
  /** Transaction hash */
  txHash: TxHash;
  /** Payer address */
  payerAddress: StellarAddress;
  /** Amount paid (deposit for per-token) */
  amount: string;
  /** Asset */
  asset: PaymentAsset;
  /** Route/model accessed */
  route: string;
  /** Payment status */
  status: PaymentStatus;
  /** When the payment was verified */
  verifiedAt: string;
  /** Block/ledger number */
  ledger: number;
  /** For per-token pricing: actual cost after response (may differ from amount) */
  actualCost?: string;
  /** For per-token pricing: tokens consumed */
  tokensUsed?: number;
}

// ── Database Record Types ────────────────────

/** A payment row returned from the database (Prisma Payment model) */
export interface PaymentRecord {
  id: string;
  quoteId: string;
  txHash: string | null;
  payerAddress: string | null;
  amount: bigint;
  asset: string;
  status: string;
  verifiedAt: Date | null;
  receiptJson: unknown | null;
  routeId: string;
  providerId: string;
  ledger: number | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Provider Types ───────────────────────────

/** A provider (merchant) registered on the gateway */
export interface Provider {
  id: string;
  name: string;
  /** Stellar wallet address for receiving payments */
  walletAddress: StellarAddress;
  /** Optional payout wallet (multisig) */
  payoutWalletAddress?: StellarAddress;
  /** Whether the provider is active */
  active: boolean;
  /** Provider metadata */
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** A protected route/endpoint configuration */
export interface RouteConfig {
  id: string;
  providerId: string;
  /** The URL path pattern (e.g., "/v1/chat/completions") */
  path: string;
  /** The upstream LLM endpoint to proxy to */
  upstreamUrl: string;
  /** The model identifier */
  model: string;
  /** Pricing model for this route */
  pricingModel: PricingModel;
  /** Flat price in smallest asset unit */
  flatPrice?: string;
  /** Price per token in smallest asset unit */
  perTokenPrice?: string;
  /** Accepted payment assets */
  acceptedAssets: PaymentAsset[];
  /** Rate limit: max unpaid 402 requests per minute */
  rateLimit: number;
  /** Whether this route is active */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Gateway Request/Response Types ───────────

/** The 402 Payment Required response body */
export interface PaymentRequiredResponse {
  status: 402;
  message: string;
  quote: Quote;
  /** Human-readable payment instructions */
  instructions: string;
  /** Link to documentation */
  docs: string;
}

/** Standard gateway error response */
export interface GatewayErrorResponse {
  status: number;
  error: string;
  message: string;
  details?: unknown;
}

// ── LLM / Proxy Types ────────────────────────

/** OpenAI-compatible chat completion request */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  stop?: string | string[];
  [key: string]: unknown;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'function';
  content: string;
  name?: string;
}

/** OpenAI-compatible chat completion response */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
  [key: string]: unknown;
}

export interface Choice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ── SSE Streaming Types ──────────────────────

/** A single SSE chunk in a streaming chat completion response */
export interface ChatCompletionStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: StreamChoice[];
  usage?: Usage;
}

/** A streaming choice with a delta (not a full message) */
export interface StreamChoice {
  index: number;
  delta: ChoiceDelta;
  finish_reason: string | null;
}

/** Partial message delta for streaming */
export interface ChoiceDelta {
  role?: 'system' | 'user' | 'assistant' | 'function';
  content?: string;
  function_call?: {
    name?: string;
    arguments?: string;
  };
}

// ── SDK Types ────────────────────────────────

/** Configuration for the x402 client SDK */
export interface X402ClientConfig {
  /** Gateway base URL */
  gatewayUrl: string;
  /** Stellar network to use */
  network: StellarNetwork;
  /** Default asset for payment */
  defaultAsset?: PaymentAsset;
  /** Secret key for signing transactions (client-side only) */
  secretKey?: string;
  /** Maximum time to wait for payment confirmation (ms) */
  paymentTimeout?: number;
  /** Function to sign a Stellar transaction */
  signTransaction?: (txXdr: string) => Promise<string>;
}

/** Result of the 402 → pay → retry flow */
export interface X402CallResult {
  success: boolean;
  /** The LLM response if successful */
  response?: ChatCompletionResponse;
  /** Payment receipt */
  receipt?: PaymentReceipt;
  /** Error if unsuccessful */
  error?: string;
  /** Total cost */
  cost?: {
    amount: string;
    asset: PaymentAsset;
  };
}

/** Result of a streaming 402 → pay → retry flow */
export interface X402StreamResult {
  success: boolean;
  /** Async generator yielding SSE chunks */
  stream?: AsyncGenerator<ChatCompletionStreamChunk, void, unknown>;
  /** Payment receipt from headers */
  receipt?: PaymentReceipt;
  /** Error if unsuccessful */
  error?: string;
  /** Total cost */
  cost?: {
    amount: string;
    asset: PaymentAsset;
  };
}

// ── Analytics / Dashboard Types ──────────────

export interface AnalyticsSummary {
  totalRequests: number;
  paidRequests: number;
  unpaidRequests: number;
  totalRevenue: string;
  revenueAsset: PaymentAsset;
  averageResponseTime: number;
  successRate: number;
  topCallers: Array<{ address: StellarAddress; totalSpent: string; requestCount: number }>;
  topRoutes: Array<{ path: string; requestCount: number; revenue: string }>;
}

export interface TimeSeriesDataPoint {
  timestamp: string;
  paidRequests: number;
  unpaidRequests: number;
  revenue: string;
  failedVerifications: number;
}

// ── Notification Types ───────────────────────

export type NotificationChannel = 'email' | 'webhook' | 'in_app';
export type NotificationEvent =
  | 'payment_received'
  | 'payout_threshold_reached'
  | 'verification_failed'
  | 'request_forwarded'
  | 'provider_registered'
  | 'route_created';

export interface Notification {
  id: string;
  providerId: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
  sent: boolean;
  createdAt: string;
}

// ── Load Balancing Types ──────────────────────

/** Load balancing strategy for routing requests across multiple providers. */
export type LoadBalancingStrategy = 'round-robin' | 'least-latency' | 'weighted';

/** Health status of a route/upstream from the load balancer's perspective. */
export interface LoadBalancerHealthStatus {
  routeId: string;
  providerId: string;
  model: string;
  upstreamUrl: string;
  weight: number;
  active: boolean;
  circuitOpen: boolean;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  averageLatencyMs: number;
  requestCount: number;
  successCount: number;
  failureCount: number;
  healthy: boolean;
}
