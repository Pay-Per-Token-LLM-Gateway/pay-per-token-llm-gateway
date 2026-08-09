# x402 LLM Gateway — Deployment Guide

This guide covers deploying the two components of the x402 LLM Gateway:

| Component | Platform | Type | Why |
|---|---|---|---|
| **Gateway** (NestJS) | Railway | Container | Long-running server with WebSockets, needs PostgreSQL + Redis |
| **Dashboard** (Next.js) | Vercel | Serverless | Next.js is natively supported with zero config |

---

## Prerequisites

- GitHub repository with the code pushed
- A Stellar testnet account with secret key (already created: `GCDD3SYSIQFT5PSRJHPHYYMCBTJKQPAMTI2GSZH4E6BFTUIVDUCGF3FK`)
- Upstream LLM API key (e.g., OpenAI API key)

---

## Part 1: Deploy Gateway to Railway

### 1.1 Create Railway Account

Go to [railway.app](https://railway.app) and sign up with GitHub.

### 1.2 Add PostgreSQL and Redis

1. Click **New Project** → **Deploy from GitHub repo**
2. Select your x402-llm-gateway repository
3. Click **+ New** → **Database** → **Add PostgreSQL**
4. Click **+ New** → **Database** → **Add Redis**

### 1.3 Configure the Gateway Service

1. Select the gateway service from your repo
2. Under **Settings** → **Environment**, add:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `STELLAR_NETWORK` | `testnet` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway reference) |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` (Railway reference) |
| `JWT_SECRET` | (Generate: `openssl rand -base64 32`) |
| `USDC_ISSUER` | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| `CORS_ORIGINS` | `https://your-dashboard.vercel.app` |
| `UPSTREAM_API_KEY_YOUR_PROVIDER_ID` | `sk-your-openai-api-key` |
| `PORT` | `3000` |

3. Under **Settings** → **Build**, set:
   - **Dockerfile path**: `infrastructure/docker/Dockerfile.gateway`

4. Under **Settings** → **Deploy**, set:
   - **Health Check Path**: `/health`

### 1.4 Deploy

Click **Deploy**. The gateway will:
1. Build the Docker image
2. Connect to PostgreSQL and Redis
3. Run Prisma migrations
4. Start on port 3000

Note the gateway URL (e.g., `https://x402-gateway.up.railway.app`).

---

## Part 2: Deploy Dashboard to Vercel

### 2.1 Create Vercel Account

Go to [vercel.com](https://vercel.com) and sign up with GitHub.

### 2.2 Import the Project

1. Click **Add New** → **Project**
2. Select your x402-llm-gateway repository
3. Configure:

| Setting | Value |
|---|---|
| **Framework** | Next.js |
| **Root Directory** | `apps/dashboard` |
| **Build Command** | `cd ../.. && pnpm install --frozen-lockfile && pnpm exec nx build dashboard` |
| **Output Directory** | `../../dist/apps/dashboard` |

### 2.3 Set Environment Variables

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_GATEWAY_URL` | `https://your-gateway.up.railway.app` |

### 2.4 Deploy

Click **Deploy**. Vercel will build and deploy the Next.js dashboard.

---

## Part 3: Initialize the Gateway

Once both services are deployed, initialize the gateway:

### 3.1 Create a Provider

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/providers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "My LLM Provider",
    "walletAddress": "GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F",
    "payoutWalletAddress": "GCDD3SYSIQFT5PSRJHPHYYMCBTJKQPAMTI2GSZH4E6BFTUIVDUCGF3FK"
  }'
```

### 3.2 Create a Route

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/routes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "providerId": "PROVIDER_ID_FROM_ABOVE",
    "path": "/v1/chat/completions",
    "upstreamUrl": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-4",
    "pricingModel": "flat",
    "flatPrice": "1000000",
    "acceptedAssets": ["USDC"],
    "rateLimit": 10
  }'
```

---

## Part 4: Test the x402 Payment Flow

### 4.1 Send Request Without Payment (Expect 402)

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
```

**Expected Response (402):**
```json
{
  "status": 402,
  "message": "Payment Required",
  "quote": {
    "id": "...",
    "amount": "1000000",
    "asset": "USDC",
    "paymentAddress": "GA5ZSE...",
    "network": "testnet"
  }
}
```

### 4.2 Pay on Stellar Testnet

Using the Stellar CLI or any Stellar wallet, send the quoted amount to the payment address:

```bash
stellar tx new --source alice --network testnet \
  --op payment --destination GA5ZSE... \
  --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --amount 0.1
```

### 4.3 Retry Request with Payment Hash

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Payment-Hash: YOUR_TRANSACTION_HASH" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
```

### 4.4 Expected Success Response

The gateway verifies the payment on-chain and proxies to the LLM:
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "choices": [...],
  "usage": {...}
}
```

---

## Deployed Contract Addresses (Testnet)

| Contract | Address |
|---|---|
| payment-verifier | `CDHGI3A2BXRC5AQDPWEEXUDQMDXTDZYBCLJZWSE5XZKMVEGJ5LLHA4CZ` |
| credit-escrow | `CCE7AWVXPO57W5KDONOPMHDV4S5UBUBMHNJVSAVPL7AZGMD4WQN6WVAP` |
| multisig | `CDMBVMMNJVAJVAV3T2TAL2TAACGTKYUS45RXNLCYKYUC3VGHBI66NWAA` |

---

## Architecture

```
┌──────────────────┐     ┌──────────────────┐
│   Vercel         │     │   Railway         │
│   Dashboard      │────▶│   Gateway         │
│   (Next.js)      │     │   (NestJS)        │
└──────────────────┘     └───────┬──────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ Postgres │ │  Redis   │ │ Stellar  │
              │ (Railway)│ │ (Railway)│ │ Testnet  │
              └──────────┘ └──────────┘ └──────────┘
```


---

## Part 5: Mainnet Deployment

> ⚠ **WARNING**: Mainnet operates with REAL USDC. Test thoroughly on testnet first.
> A single misconfiguration can cost real money. Review each step carefully.

### 5.1 Prerequisites

Before deploying to mainnet, ensure you have:

- **Stellar mainnet account** funded with real XLM (for transaction fees) and USDC
- **Circle USDC issuer on mainnet**: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
- **Soroban mainnet contracts** deployed (see [5.5 Deploy Contracts](#55-deploy-contracts))
- **Production-grade PostgreSQL and Redis** (Railway, AWS RDS, Upstash, or ElastiCache)
- **HTTPS certificate** for the gateway (Railway provides this automatically)
- **JWT_SECRET** generated with `openssl rand -base64 32`

### 5.2 Environment Variables for Mainnet

| Variable | Value |
|---|---|
| `STELLAR_NETWORK` | `mainnet` |
| `HORIZON_URL` | `https://horizon.stellar.org` |
| `SOROBAN_RPC_URL` | `https://soroban-mainnet.stellar.org` |
| `USDC_ISSUER` | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | (Generate: `openssl rand -base64 32`) |

A complete `.env.mainnet.example` is provided in the repository — copy it and fill in your values.

### 5.3 Docker Compose (Mainnet)

Use the dedicated mainnet Docker Compose file:

```bash
docker compose -f infrastructure/docker/docker-compose.mainnet.yml up -d
```

This file requires the following environment variables (set them in a `.env` file or shell):

```bash
POSTGRES_PASSWORD=<strong-random-password>
REDIS_PASSWORD=<strong-random-password>
JWT_SECRET=<openssl rand -base64 32>
CORS_ORIGINS=https://your-dashboard.vercel.app
```

### 5.4 Railway Deployment (Mainnet)

1. Follow [Part 1](#part-1-deploy-gateway-to-railway) to set up PostgreSQL and Redis
2. Under **Settings → Environment**, set the mainnet variables from the table above
3. Set `STELLAR_NETWORK=mainnet` and the mainnet `USDC_ISSUER`
4. **Security hardening**:
   - Use Railway's `${{Postgres.DATABASE_URL}}` references (never hardcode credentials)
   - Set `JWT_SECRET` as a Railway secret (not in the repo)
   - Enable Railway's private networking for inter-service communication
   - Set `CORS_ORIGINS` to your exact dashboard URL (no wildcards)

### 5.5 Deploy Contracts to Mainnet

The Soroban contracts must be deployed to Stellar mainnet before the gateway can use them:

```bash
# Set up your mainnet identity
stellar config --network mainnet
stellar accounts create --source MAINNET_ACCOUNT_ID

# Deploy payment-verifier (requires mainnet XLM for fees)
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/payment_verifier.wasm \
  --source MAINNET_ACCOUNT_ID \
  --network mainnet

# Deploy credit-escrow
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/credit_escrow.wasm \
  --source MAINNET_ACCOUNT_ID \
  --network mainnet

# Deploy multisig
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/multisig.wasm \
  --source MAINNET_ACCOUNT_ID \
  --network mainnet
```

After deployment, update the contract addresses in your environment variables:

```bash
PAYMENT_VERIFIER_CONTRACT=<deployed-address>
CREDIT_ESCROW_CONTRACT=<deployed-address>
MULTISIG_CONTRACT=<deployed-address>
```

### 5.6 Security Considerations

| Concern | Mitigation |
|---|---|
| **Real USDC at risk** | Test thoroughly on testnet first. Start with minimum payment amounts. |
| **Secret key exposure** | Use a dedicated mainnet account with minimal balance. Never commit secrets to the repo. |
| **Rate limiting** | Mainnet has lower Soroban RPC rate limits. Monitor gateway logs. |
| **Contract upgrades** | Soroban contracts are immutable once deployed. Use a proxy pattern for upgradability. |
| **Monitoring** | Set up alerts for verification failures, anomalous payment patterns, and gateway health. |
| **Audit trail** | Every payment is recorded on-chain. Maintain a separate off-chain ledger for reconciliation. |

### 5.7 Testing Mainnet

Before going live, run these checks:

1. **Payment flow**: Execute a small-value request through the mainnet gateway and verify the full 402 → pay → retry cycle
2. **Contract integration**: Verify the credit-escrow contract reads/writes balances correctly
3. **Dashboard**: Confirm the provider dashboard shows real-time mainnet data
4. **Failover**: Test that the gateway falls back gracefully when Horizon or Soroban RPC is unavailable
