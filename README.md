<p align="center">
  <img src="apps/dashboard/public/icon.svg" alt="x402 Logo" width="140" />
</p>

<h1 align="center">x402 LLM Gateway</h1>

<p align="center">
  <strong>Pay-per-request LLM gateway with stablecoin micropayments on Stellar.</strong>
  <br />
  No API keys. No subscriptions. No rate limits.
  <br />
  Just pay USDC on-chain and access any LLM endpoint.
</p>

<p align="center">
  <a href="#-architecture"><strong>Architecture</strong></a> ·
  <a href="#-quickstart"><strong>Quickstart</strong></a> ·
  <a href="#-api-reference"><strong>API</strong></a> ·
  <a href="#-client-sdk"><strong>SDK</strong></a> ·
  <a href="#-smart-contracts"><strong>Contracts</strong></a> ·
  <a href="#-deployment"><strong>Deploy</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Stellar-Testnet-green" alt="Stellar Testnet" />
  <img src="https://img.shields.io/badge/NestJS-10.x-red" alt="NestJS" />
  <img src="https://img.shields.io/badge/Next.js-14.x-black" alt="Next.js" />
  <img src="https://img.shields.io/badge/Soroban-Rust-orange" alt="Soroban Rust" />
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="License MIT" />
</p>

---

## What is x402?

**x402** extends the HTTP 402 Payment Required status code into a real protocol for AI API access. Instead of managing API keys, rate limits, and billing systems, you pay for each request with stablecoins on the Stellar blockchain.

The gateway acts as a reverse proxy that:

1. **Receives** an LLM API request (OpenAI-compatible format)
2. **Returns HTTP 402** with a Stellar payment address and price quote
3. **Verifies** the on-chain payment via Horizon
4. **Forwards** the request to the upstream LLM
5. **Returns** the LLM response with a payment receipt

This enables **permissionless AI access** — anyone with a Stellar wallet can use LLMs without signing up, providing payment details, or managing API keys.

### Why Stellar?

| Feature | Benefit |
|---------|---------|
| **$0.00001 fees** | Economical for micropayments as small as $0.001 |
| **5-second finality** | Near-instant payment confirmation |
| **USDC native** | Stablecoin support without bridges or wrapped tokens |
| **Soroban smart contracts** | On-chain verification, escrow, and multisig payouts |
| **Horizon API** | Simple REST API for querying transactions |

---

## 🌐 Architecture

```
                        HTTP 402 + Quote
   ┌──────────────┐ ◄──────────────────── ┌──────────────────────┐
   │              │                        │                      │
   │   Caller     │ ──── Pay USDC ───────► │   x402 Gateway       │
   │  (Agent/App) │                        │   (NestJS)           │
   │              │ ◄─── LLM Response ──── │                      │
   └──────────────┘                        └──────────┬───────────┘
                                             │        │
                                    ┌────────┘        └─────────┐
                                    ▼                            ▼
                           ┌──────────────┐          ┌──────────────────┐
                           │   Stellar    │          │   Upstream LLM   │
                           │   Horizon /  │          │   OpenAI, etc.   │
                           │   Soroban    │          │                  │
                           └──────┬───────┘          └──────────────────┘
                                  │
                                  ▼
                           ┌──────────────┐
                           │   Provider   │
                           │   Dashboard  │
                           │   (Next.js)  │
                           └──────────────┘
```

### Detailed Flow

```
Caller                Gateway                 Stellar              Upstream LLM
  │                      │                       │                      │
  │── POST /chat ───────►│                       │                      │
  │                      │                       │                      │
  │◄─ 402 {quote} ───────│                       │                      │
  │                      │                       │                      │
  │───── Payment ────────│──────────────────────►│                      │
  │                      │                       │── confirm ──────────►│
  │                      │◄── tx_recorded ───────│                      │
  │                      │                       │                      │
  │── POST + txHash ────►│                       │                      │
  │                      │── verify tx ─────────►│                      │
  │                      │◄── tx_valid ──────────│                      │
  │                      │                       │                      │
  │                      │────────────────────────────── forward ──────►│
  │                      │◄───────────────────────────── response ──────│
  │◄─ LLM response ──────│                       │                      │
```

---

## ✨ Features

### Core Gateway
- **HTTP 402 Payment Required** — Standards-compliant payment flow
- **OpenAI-compatible API** — Drop-in replacement for `/v1/chat/completions`
- **Streaming (SSE) support** — Real-time token streaming to clients
- **Replay protection** — Each transaction hash can only be used once, backed by Redis
- **Rate limiting** — Configurable per-route rate limits for unpaid requests
- **Multi-provider** — Host multiple LLM providers behind one gateway
- **Per-route configuration** — Different pricing, models, and upstream URLs per route

### 💰 Pricing Models

| Model | How It Works | Use Case |
|-------|-------------|----------|
| **Flat-rate** | Fixed price per request | Standard API access, known costs |
| **Per-token** | Pay per token consumed (`usage.total_tokens`) | Variable-length responses, fair billing |

For per-token pricing, the client sends a deposit (estimated from `max_tokens`), the gateway calculates actual cost from the response's `usage.total_tokens`, and the surplus/underpayment is reported via response headers.

### 📊 Dashboard (Next.js)
- Real-time revenue and request analytics
- Route and provider CRUD management
- Payment history with filtering and pagination
- Audit log of all gateway operations
- Wallet-based authentication (Freighter, xBull, Albedo)
- Webhook configuration and testing

### 🔗 Client SDK
- TypeScript/JavaScript SDK with automatic 402 → pay → retry flow
- Streaming support via async generators
- Stellar wallet integration (secret key or external signer)
- Payment confirmation polling with configurable timeout
- Lightweight — depends only on `stellar-sdk` and `fetch`

### 📡 Notifications
- Webhook delivery with retry logic
- Event types: `payment_received`, `verification_failed`, `request_forwarded`
- Extensible notification channel system

---

## 📁 Monorepo Structure

```
x402-llm-gateway/
├── apps/
│   ├── gateway/              # NestJS reverse proxy server
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── proxy/        # HTTP proxy with 402 flow
│   │       │   ├── x402/         # Quote generation, payment verification
│   │       │   ├── payments/     # Payment records and status
│   │       │   ├── routes/       # Route configuration CRUD
│   │       │   ├── providers/    # Provider management
│   │       │   ├── analytics/    # Usage and revenue analytics
│   │       │   ├── admin/        # Audit logs and admin operations
│   │       │   ├── webhooks/     # Webhook delivery
│   │       │   └── auth/         # Wallet-based authentication
│   │       ├── common/           # Guards, filters, shared modules
│   │       └── e2e/              # End-to-end tests
│   └── dashboard/            # Next.js provider dashboard
│       └── src/
│           ├── app/              # Pages (routes, payments, settings, etc.)
│           ├── components/       # UI components (sidebar, navbar, providers)
│           └── lib/              # API client, hooks, auth utilities
│
├── contracts/                # Soroban smart contracts (Rust)
│   ├── payment-verifier/     # On-chain payment recording
│   ├── credit-escrow/        # Prepaid credit balances
│   └── multisig/             # Provider payout wallet security
│
├── packages/                 # Shared libraries (published as @x402/*)
│   ├── types/                # TypeScript type definitions
│   ├── x402-core/            # Quote generation, payment verification, replay protection
│   ├── sdk/                  # Client SDK (402 → pay → retry)
│   ├── config/               # Centralized configuration with env validation
│   ├── logger/               # Structured logging (text + JSON modes)
│   ├── validation/           # Zod schemas for request validation
│   ├── database/             # Prisma client, schema, and migrations
│   ├── wallet/               # Stellar wallet utilities (tx building, Horizon)
│   ├── authentication/       # Wallet challenge-response auth
│   ├── analytics/            # Usage & revenue analytics service
│   ├── notifications/        # Email/webhook/in-app notification delivery
│   ├── shared/               # General utilities (ID generation, timestamps)
│   └── ui/                   # Shared UI utilities
│
├── infrastructure/
│   └── docker/               # Dockerfiles (gateway, dashboard) + compose
│
├── .github/workflows/
│   ├── ci.yml                # Lint → Test → Build (with PostgreSQL + Redis services)
│   └── deploy.yml            # Docker push + Soroban contract deployment (tag-triggered)
│
└── docs/                     # Documentation
    ├── README.md
    ├── DEPLOYMENT.md
    ├── CONTRIBUTING.md
    └── SECURITY.md
```

### Database Schema

| Model | Purpose |
|-------|---------|
| `Provider` | LLM provider/merchant with Stellar wallet |
| `Route` | Protected endpoint → upstream mapping with pricing |
| `Payment` | Payment records with on-chain verification data |
| `Wallet` | Stellar wallet addresses |
| `PrepaidCredit` | Escrow balances for credit-based billing (v2) |
| `ApiKey` | Provider API keys for dashboard access |
| `Session` | Auth sessions with JWT tokens |
| `Notification` | Delivered notification records |
| `AnalyticsEvent` | Request and payment events for analytics |
| `AuditLog` | Immutable audit trail of all operations |

---

## 🚀 Quickstart

### Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 9
- **PostgreSQL** ≥ 16
- **Redis** ≥ 7
- **Rust** (optional — only needed for Soroban contracts)

### 1. Clone and Install

```bash
git clone https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway.git
cd pay-per-token-llm-gateway

pnpm install
pnpm nx run database:generate
cp .env.example .env
```

### 2. Start Infrastructure

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d
```

### 3. Set Up Database

```bash
pnpm nx run database:push
```

### 4. Run the Gateway

```bash
pnpm dev:gateway
# → http://localhost:3000
# → Swagger docs: http://localhost:3000/api/docs
# → Health check: http://localhost:3000/health
```

### 5. Run the Dashboard

```bash
pnpm dev:dashboard
# → http://localhost:3001
```

### 6. Test the 402 Flow

```bash
# Without payment — expect HTTP 402
curl -X POST http://localhost:3000/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello, world!"}]
  }'
```

---

## 📡 API Reference

### Proxy Endpoint

```
POST /api/v1/chat/completions
```

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | `application/json` |
| `X-Payment-Hash` | No | Stellar transaction hash (required after paying) |

**Request body:** OpenAI-compatible chat completion request.

**Responses:**

| Status | Condition |
|--------|-----------|
| `200` | Payment verified, LLM response returned |
| `402` | Payment required — quote and instructions in body |
| `404` | No route configured for the requested model |
| `502` | Upstream LLM request failed |

### 402 Response Body

```json
{
  "status": 402,
  "message": "Payment Required",
  "quote": {
    "id": "uuid",
    "route": "/api/v1/chat/completions",
    "pricingModel": "flat",
    "amount": "1000000",
    "asset": "USDC",
    "paymentAddress": "GA5ZSE...",
    "network": "testnet",
    "expiresAt": 1712345678,
    "statusUrl": "http://localhost:3000/api/v1/payments/uuid/status"
  },
  "instructions": "Send 1000000 USDC to GA5ZSE... then retry with X-Payment-Hash header",
  "docs": "http://localhost:3000/api/docs"
}
```

### Management API

```
# Providers
GET    /api/v1/providers
POST   /api/v1/providers
GET    /api/v1/providers/:id
PUT    /api/v1/providers/:id
DELETE /api/v1/providers/:id

# Routes
GET    /api/v1/routes
POST   /api/v1/routes
GET    /api/v1/routes/:id
PUT    /api/v1/routes/:id
DELETE /api/v1/routes/:id

# Payments
GET    /api/v1/payments
GET    /api/v1/payments/:quoteId/status

# Analytics
GET    /api/v1/analytics/summary
GET    /api/v1/analytics/timeseries

# Admin
GET    /api/v1/admin/audit

# Webhooks
POST   /api/v1/webhooks/test

# Auth
POST   /api/v1/auth/challenge
POST   /api/v1/auth/verify
GET    /api/v1/auth/session
DELETE /api/v1/auth/session
```

---

## 📦 Client SDK

```typescript
import { X402Client } from '@x402/sdk';

const client = new X402Client({
  gatewayUrl: 'https://my-gateway.example.com',
  secretKey: 'S...',        // Your Stellar secret key for auto-pay
  network: 'testnet',
  defaultAsset: 'USDC',
});

// Standard call — automatic 402 → pay → retry
const result = await client.call({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Explain x402 in one sentence.' }],
});

if (result.success) {
  console.log(result.response.choices[0].message.content);
  console.log(`Cost: ${result.cost.amount} ${result.cost.asset}`);
}

// Streaming call
const stream = await client.callStream({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Tell me a story.' }],
});

if (stream.success && stream.stream) {
  for await (const chunk of stream.stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}
```

### How the SDK Works

1. Sends the LLM request to the gateway
2. If HTTP 402: parses the quote, builds a Stellar payment transaction, signs and submits it
3. Polls Horizon for confirmation
4. Retries the original request with `X-Payment-Hash` header
5. Returns the LLM response

All of this is transparent to the caller — you write normal LLM API code and the SDK handles payments automatically.

---

## 🔐 Smart Contracts

Three Soroban (Rust) smart contracts provide on-chain guarantees:

### Payment Verifier
Records verified payments on-chain with immutable audit trail. Provides:
- `record_payment` — Admin-only payment recording with replay protection
- `is_payment_used` — Deduplication check by transaction hash
- `get_payment` / `get_payments` — Paginated payment queries

### Credit Escrow
Holds prepaid credit balances for account-based billing (v2):
- `deposit` / `withdraw` — Token deposit and withdrawal
- `charge` — Admin-only balance deduction for usage
- `balance` / `get_usage` — Balance checks and usage history

### Multisig Wallet
Requires M-of-N signer approval for provider payouts:
- `propose` — Create a payout proposal
- `approve` — Signer approval; executes transfer when threshold is met
- `get_proposal` / `get_config` — Proposal and configuration queries

### Deploying Contracts

```bash
cargo install --locked stellar-cli --features opt

cd contracts/payment-verifier
stellar contract build
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/payment_verifier.wasm \
  --source S... \
  --network testnet
```

---

## 🐳 Deployment

### Gateway → Railway

```bash
# railway.json is pre-configured
# Deploy via Railway dashboard or CLI
railway up
```

The gateway Docker image includes Node.js, pnpm, Prisma client generation, and the NestJS build. Railway auto-provisions PostgreSQL and Redis.

### Dashboard → Vercel

```bash
# vercel.json is pre-configured
vercel --prod
```

### Docker

```bash
docker compose -f infrastructure/docker/docker-compose.yml build
docker compose -f infrastructure/docker/docker-compose.yml up -d
```

### Contract Deployment

CI automatically deploys contracts to Stellar testnet on `v*` tags (requires `STELLAR_SECRET_KEY` secret).

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the complete step-by-step guide.

---

## 🔧 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Environment (`production`, `test`, `development`) |
| `PORT` | `3000` | Gateway server port |
| `HOST` | `0.0.0.0` | Gateway server host |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_URL` | — | Redis connection string |
| `STELLAR_NETWORK` | `testnet` | Stellar network (`testnet`, `mainnet`, `futurenet`) |
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | Horizon API endpoint |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Stellar network passphrase |
| `USDC_ISSUER` | `GBBD47...` | USDC token issuer on Stellar |
| `CREDIT_ESCROW_CONTRACT` | configured testnet contract | Credit-escrow Soroban contract ID |
| `CONTRACT_ADMIN_SECRET` | — | Gateway signer authorized to call `credit-escrow.charge`; `STELLAR_SECRET_KEY` is accepted as a compatibility fallback |
| `JWT_SECRET` | — | Secret key for JWT session tokens |
| `QUOTE_EXPIRY_SECONDS` | `300` | Time before quotes expire (5 min) |
| `LLM_REQUEST_TIMEOUT` | `120000` | Upstream LLM timeout in ms |
| `CORS_ORIGINS` | `http://localhost:3001` | Allowed CORS origins (comma-separated) |
| `UPSTREAM_API_KEY_<PROVIDER>` | — | Upstream LLM API key per provider |

### Credit escrow flow

Authenticated wallet sessions may use prepaid credit without sending an
`X-Payment-Hash`. The gateway simulates `balance(user)` before forwarding a
USDC-priced request, skips Horizon verification when the estimate is covered,
then submits `charge(user, actualCost, quoteId)` after the upstream response.
If the contract, RPC, session, or balance check is unavailable, the existing
x402 per-request flow remains the fallback. The dashboard exposes the
authenticated wallet's balance and `get_usage` history at **Credit Escrow**.

---

## 🗺️ Roadmap

### ✅ v1 — Completed

- [x] Gateway reverse proxy with HTTP 402 flow
- [x] Flat-rate and per-token pricing models
- [x] Stellar payment verification via Horizon
- [x] Redis-backed replay protection
- [x] TypeScript Client SDK (402 → pay → retry)
- [x] Next.js provider dashboard with analytics
- [x] Payment history, audit logs, webhook notifications
- [x] Wallet-based authentication (Freighter, xBull, Albedo)
- [x] Soroban smart contracts (payment-verifier, credit-escrow, multisig)
- [x] CI/CD pipeline (lint → test → build → deploy)
- [x] Docker images and Railway/Vercel deployment configs

### 🚧 v2 — In Progress

- [ ] Multi-provider routing with load balancing
- [ ] Python SDK with LangChain integration
- [ ] Streaming (SSE) support with per-token pricing in SDK
- [ ] Kubernetes deployment manifests
- [ ] Provider payout automation via multisig contracts
- [x] Prepaid credit escrow contract integration with authenticated proxy fallback

### 💡 v3 — Planned

- [ ] Stellar mainnet launch
- [ ] Multi-chain support (EVM chains, Solana)
- [ ] Decentralized provider registry on Soroban
- [ ] Fiat on-ramp integration (credit card → USDC → LLM)
- [ ] LLM benchmark and quality-of-service scoring on-chain

---

## 🛡️ Security

### Trust Model

- **Blockchain as source of truth** — All payments verified on-chain via Horizon
- **Zero trust for clients** — Client-submitted payment proofs are never trusted
- **Server-side API keys** — Upstream LLM keys are never exposed to callers
- **Replay protection** — Every transaction hash tracked; double-use rejected
- **Rate limiting** — Unpaid requests are throttled per IP/wallet

### Production Checklist

- [ ] Use dedicated Horizon/Soroban RPC providers with API keys
- [ ] Enable Redis persistence (AOF) for replay protection durability
- [ ] Run behind Cloudflare/NGINX with TLS termination
- [ ] Rotate JWT secrets regularly
- [ ] Use separate Stellar accounts for receiving vs. payouts
- [ ] Set up monitoring alerts for payment verification failures
- [ ] Implement circuit breakers for upstream LLM failures

See [SECURITY.md](./SECURITY.md) for full security policy.

---

## 🤝 Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for:

- Development setup
- Conventional Commits format
- Code style guide
- Testing instructions
- PR review process

---

## 📄 License

MIT License — see [LICENSE](./LICENSE) for details.

---

<p align="center">
  Built with ❤️ on <a href="https://stellar.org">Stellar</a> — the blockchain for real-world payments.
</p>
