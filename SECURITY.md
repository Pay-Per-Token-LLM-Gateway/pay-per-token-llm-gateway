# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the x402 LLM Gateway, please report it responsibly.

**Do not open a public GitHub issue.**

Instead, [open a private security advisory](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/security/advisories/new) or email the maintainers with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will respond within 48 hours and work with you on a fix.

## Security Model

### Trust Assumptions

1. **Stellar blockchain is the single source of truth** — all payments are verified on-chain
2. **Client payment proofs are never trusted** — Horizon/Soroban RPC queries are mandatory
3. **Upstream LLM API keys are server-side only** — never exposed to callers

### Replay Protection

Transaction hashes are tracked in Redis (or PostgreSQL) with a TTL. The same transaction cannot be used for multiple requests. In production, use Redis persistence (AOF/RDB) to survive restarts.

### Rate Limiting

Unpaid 402 requests are rate-limited by caller IP. This prevents quote-spam
and resource exhaustion attacks.

For the paid tier, the rate limit can optionally be keyed by the payer's
Stellar wallet address instead of IP by setting `RATE_LIMIT_BY_WALLET=true`.
This prevents IP-rotation attacks on the paid tier when the gateway is
directly exposed without a reverse proxy. The wallet address is read from the
confirmed payment row (`Payment.payerAddress`) — it is never taken from a
client-supplied header.

### Trust Proxy

The gateway uses Express's `trust proxy` setting (configured via `TRUST_PROXY`)
to resolve the real client IP behind a reverse proxy. **When the gateway is
directly exposed (no Cloudflare, NGINX, or Railway), setting `TRUST_PROXY=1`
(the default) trusts the left-most `X-Forwarded-For` header, which a client
can spoof to bypass IP-based rate limits.**

In production:
- **Behind a reverse proxy**: set `TRUST_PROXY` to match your proxy setup
  (`"1"`, `"loopback"`, or a comma-separated list of proxy IPs).
- **Directly exposed**: set `TRUST_PROXY=0` and consider
  `RATE_LIMIT_BY_WALLET=true` for the paid tier.

### Key Management

- Upstream LLM API keys are environment variables: `UPSTREAM_API_KEY_<PROVIDER_ID>`
- JWT secrets must be at least 256 bits
- Stellar secret keys are **never** stored server-side. The gateway only uses public keys to verify payments.

### Audit

All payment verifications, request forwarding, and admin actions are logged to the `AuditLog` table for forensic analysis.

## Security Checklist for Production

- [ ] Use a dedicated Horizon/Soroban RPC provider with API keys
- [ ] Enable Redis persistence (AOF)
- [ ] Run behind Cloudflare/NGINX with rate limiting
- [ ] Set up monitoring alerts for failed verifications
- [ ] Rotate JWT secrets regularly
- [ ] Use separate Stellar accounts for receiving payments vs. payouts
- [ ] Implement withdrawal limits for provider payouts
- [ ] Regular security audits of the codebase
