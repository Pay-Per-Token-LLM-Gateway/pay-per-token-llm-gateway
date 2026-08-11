# Changelog

All notable changes to the x402 LLM Gateway project.

---

## [Unreleased]

### Added
- Initial project structure and documentation

### Changed
- N/A

### Fixed
- N/A

---

## [0.1.0] — 2026-08-11

## [0.1.0] — 2026-08-11

### Added

- **Gateway:** Reverse proxy with HTTP 402 Payment Required flow for LLM APIs
- **Gateway:** Flat-rate and per-token pricing models with metered billing
- **Gateway:** Triple-layered replay protection (Redis SET NX → on-chain contract → DB unique constraint)
- **Gateway:** SSRF guards for webhook and upstream URLs with DNS resolution
- **Gateway:** Rate limiting (paid/unpaid tiers, sliding-window Redis Lua script)
- **Gateway:** Circuit breaker for upstream LLM failures
- **Gateway:** Streaming (SSE) support for chat completions
- **Gateway:** Multi-tenant isolation — all data scoped by authenticated wallet
- **Gateway:** Audit logging of all gateway operations
- **Gateway:** Webhook notifications with HMAC signatures and retry logic
- **Gateway:** Wallet-based authentication (challenge-response with Stellar keys)
- **Gateway:** Escrow settlement via credit-escrow Soroban contract (charge + refund)
- **Dashboard:** Next.js provider dashboard with route/payment management
- **Dashboard:** Real-time analytics (summary, time series, top callers/routes)
- **Dashboard:** Wallet authentication (Freighter, xBull, Albedo)
- **SDK:** TypeScript client with automatic 402 → pay → retry flow
- **SDK:** Streaming support via async generators
- **SDK:** External wallet signing (publicKey + signTransaction)
- **Contracts:** Payment Verifier — on-chain payment recording with replay protection
- **Contracts:** Credit Escrow — prepaid balance management with idempotent charge/refund
- **Contracts:** Multisig Wallet — M-of-N signer approval for provider payouts
- **CI/CD:** Lint → unit tests (coverage thresholds) → E2E → contract tests → security audit
- **CI/CD:** Docker images for gateway and dashboard
- **CI/CD:** Railway + Vercel deployment configs
- **Docs:** README, DEPLOYMENT.md, SECURITY.md, CONTRIBUTING.md, AUDIT.md

### Fixed (from audit — Phase 1)

- **C2:** SDK external signer path now works (`publicKey` + `signTransaction`)
- **C5:** Streaming responses now include receipt/cost as trailing SSE event
- **M2:** `minPaymentAmount` enforced in quote generation and payment verification
- **M4:** RateLimitGuard added to PaymentsController public status endpoint
- **C1:** Escrow settlement wired into proxy controller (charge + auto-refund surplus)

### Known Limitations

- Email notification handler is a placeholder (not yet wired to SMTP)
- Circuit breaker is in-memory only (not shared across gateway instances)
- Dashboard and SDK lack dedicated test suites
- DNS rebinding TOCTOU on upstream URLs (config-time validation only)
