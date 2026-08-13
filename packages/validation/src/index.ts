// ──────────────────────────────────────────────
// @x402/validation — Zod schemas for all I/O
// ──────────────────────────────────────────────

import { z } from 'zod';

// ── Stellar ──────────────────────────────────

export const stellarAddressSchema = z.string().regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar address');

export const txHashSchema = z.string().regex(/^[a-f0-9]{64}$/i, 'Invalid transaction hash');

export const paymentAssetSchema = z.enum(['USDC', 'XLM']);

export const stellarNetworkSchema = z.enum(['testnet', 'mainnet', 'futurenet']);

// ── x402 Protocol ────────────────────────────

export const pricingModelSchema = z.enum(['flat', 'per_token']);

export const paymentStatusSchema = z.enum([
  'pending',
  'confirmed',
  'failed',
  'refunded',
  'expired',
]);

export const quoteSchema = z.object({
  id: z.string().uuid(),
  route: z.string().min(1),
  pricingModel: pricingModelSchema,
  amount: z.string().min(1),
  asset: paymentAssetSchema,
  assetIssuer: z.string().optional(),
  paymentAddress: stellarAddressSchema,
  memo: z.string().optional(),
  expiresAt: z.number().positive(),
  network: stellarNetworkSchema,
  statusUrl: z.string().url(),
});

export const paymentVerificationSchema = z.object({
  verified: z.boolean(),
  txHash: txHashSchema,
  payerAddress: stellarAddressSchema,
  amount: z.string(),
  asset: paymentAssetSchema,
  ledger: z.number().int().positive(),
  timestamp: z.number().positive(),
  failureReason: z.string().optional(),
});

// ── Chat Completion ──────────────────────────

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'function']),
  content: z.string(),
  name: z.string().optional(),
});

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(chatMessageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().min(0).max(1).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    stream: z.boolean().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

// ── Provider / Route ─────────────────────────

export const providerSchema = z.object({
  name: z.string().min(1).max(100),
  walletAddress: stellarAddressSchema,
  payoutWalletAddress: stellarAddressSchema.optional(),
  // Empty string is allowed so clients can clear a configured webhook
  // (the service treats "" as "no webhook"). Non-empty values are further
  // SSRF-validated (HTTPS + public IP) by the gateway before persisting.
  webhookUrl: z.union([z.string().url(), z.literal('')]).optional(),
  webhookSecret: z.string().min(16).optional(),
  metadata: z.record(z.string()).optional(),
});

/** Create-provider payload (ownership always comes from the auth wallet). */
export const providerCreateSchema = providerSchema.omit({ walletAddress: true });

/** Update-provider payload — every field optional. */
export const providerUpdateSchema = providerSchema
  .omit({ walletAddress: true, metadata: true })
  .partial();

/**
 * Cross-field refinement: each pricing model requires its own price field.
 * Without this, a `flat` route with no `flatPrice` quotes amount 0 (free
 * access) and a `per_token` route with no `perTokenPrice` computes to 0.
 */
function enforcePricingPrice(
  data: { pricingModel?: 'flat' | 'per_token'; flatPrice?: string; perTokenPrice?: string },
  ctx: z.RefinementCtx,
): void {
  if (data.pricingModel === 'flat' && data.flatPrice === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['flatPrice'],
      message: 'flatPrice is required when pricingModel is "flat"',
    });
  }
  if (data.pricingModel === 'per_token' && data.perTokenPrice === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['perTokenPrice'],
      message: 'perTokenPrice is required when pricingModel is "per_token"',
    });
  }
}

const upstreamSchema = z.object({
  url: z.string().url(),
  weight: z.number().int().min(1).max(100).default(1),
  active: z.boolean().default(true),
});

/** Base route fields (shared by create/update schemas). */
const routeConfigBase = z.object({
  providerId: z.string().uuid(),
  path: z.string().min(1).startsWith('/'),
  upstreams: z.array(upstreamSchema).min(1),
  model: z.string().min(1),
  pricingModel: pricingModelSchema,
  // Prices must be non-negative integer stroop amounts — a malformed string
  // (e.g. "abc") would crash BigInt() during quote generation.
  flatPrice: z.string().regex(/^\d+$/, 'flatPrice must be a non-negative integer').optional(),
  perTokenPrice: z
    .string()
    .regex(/^\d+$/, 'perTokenPrice must be a non-negative integer')
    .optional(),
  acceptedAssets: z.array(paymentAssetSchema).min(1),
  rateLimit: z.number().int().positive().default(10),
});

/** Create-route payload — prices must be numeric and match the pricing model. */
export const routeConfigSchema = routeConfigBase.superRefine(enforcePricingPrice);

/** Update-route payload — every field optional, prices must be non-negative integers. */
export const routeUpdateSchema = routeConfigBase
  .omit({ providerId: true, path: true, model: true, acceptedAssets: true })
  .partial()
  .extend({
    flatPrice: z.string().regex(/^\d+$/, 'flatPrice must be a non-negative integer').optional(),
    perTokenPrice: z
      .string()
      .regex(/^\d+$/, 'perTokenPrice must be a non-negative integer')
      .optional(),
  })
  .superRefine(enforcePricingPrice);

// ── Payment ──────────────────────────────────

export const verifyPaymentSchema = z.object({
  txHash: txHashSchema,
  quoteId: z.string().uuid(),
});

export const paymentReceiptSchema = z.object({
  id: z.string().uuid(),
  quoteId: z.string().uuid(),
  txHash: txHashSchema,
  payerAddress: stellarAddressSchema,
  amount: z.string(),
  asset: paymentAssetSchema,
  route: z.string(),
  status: paymentStatusSchema,
  verifiedAt: z.string().datetime(),
  ledger: z.number().int().positive(),
});

// ── Pagination ───────────────────────────────

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
