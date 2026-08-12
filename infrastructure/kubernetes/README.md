# x402 Gateway — Kubernetes Deployment

Production-ready Kubernetes manifests for the x402 LLM Gateway stack:
the NestJS gateway, Next.js dashboard, PostgreSQL, and Redis — with
namespace isolation, TLS ingress, resource limits, and health probes.

## Architecture

```
                         ┌──────────────────────────┐
                         │  Ingress (nginx + TLS)   │
                         │  gateway.example.com     │
                         │  dashboard.example.com   │
                         └──────┬───────────┬───────┘
                                │           │
                        ┌───────▼───┐ ┌─────▼────────┐
                        │  gateway  │ │  dashboard   │
                        │  :3000    │ │  :3001       │
                        │  ×2       │ │  ×2          │
                        └───┬───┬───┘ └──────────────┘
                            │   │
                    ┌───────▼───▼───────┐
                    │ postgres  :5432   │
                    │ redis     :6379   │
                    │ (StatefulSets +   │
                    │  PVCs)            │
                    └───────────────────┘
```

| Component | Kind        | Replicas | Port | Persistence | Probes                         |
| --------- | ----------- | -------- | ---- | ----------- | ------------------------------ |
| gateway   | Deployment  | 2        | 3000 | —           | `/health` (ready/live/startup) |
| dashboard | Deployment  | 2        | 3001 | —           | `/` (ready/live/startup)       |
| postgres  | StatefulSet | 1        | 5432 | 10Gi PVC    | `pg_isready`                   |
| redis     | StatefulSet | 1        | 6379 | 1Gi PVC     | `redis-cli ping`               |

## Prerequisites

- A Kubernetes cluster (kind, k3s, minikube, EKS, GKE, …) with `kubectl`.
- An ingress-nginx controller (`kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.10.1/deploy/static/provider/cloud/deploy.yaml`), or change `ingressClassName` in `ingress.yaml` to your controller.
- Docker images built and pushed (`.github/workflows/deploy.yml` publishes `x402/gateway` and `x402/dashboard` on version tags).
- A Stellar network account (testnet) and upstream LLM API keys — see the repo's `.env.example` / `DEPLOYMENT.md`.

## Deploy

### 1. Edit the secrets

`secret.yaml` ships with `CHANGE_ME_*` placeholders. Replace them with real
secrets **before** applying — never commit real secrets:

```bash
openssl rand -base64 32      # JWT_SECRET, POSTGRES_PASSWORD, REDIS_PASSWORD
```

Keep `DATABASE_URL` / `REDIS_URL` passwords in sync with
`POSTGRES_PASSWORD` / `REDIS_PASSWORD`. Set the contract IDs
(`PAYMENT_VERIFIER_CONTRACT`, `CREDIT_ESCROW_CONTRACT`, `MULTISIG_CONTRACT`)
from `contracts/deployed-addresses.json` and add an
`UPSTREAM_API_KEY_<provider>` per LLM provider.

### 2. Apply the stack

```bash
kubectl apply -k infrastructure/kubernetes/
```

### 3. Create the TLS secret

```bash
kubectl -n x402 create secret tls x402-tls --cert=tls.crt --key=tls.key
```

Or automate issuance with cert-manager. Update the hostnames in
`ingress.yaml` to your real domain first.

### 4. Run migrations

The gateway image does **not** run Prisma migrations on boot. Apply the
schema once, before the deployment starts serving:

```bash
kubectl apply -f infrastructure/kubernetes/migrations-job.yaml
kubectl -n x402 wait --for=condition=complete job/prisma-migrate --timeout=300s
kubectl -n x402 logs job/prisma-migrate
```

Re-run the Job after every upgrade that ships a new migration.

### 5. Verify

```bash
kubectl -n x402 get pods,svc,ingress
kubectl -n x402 get svc gateway   # ClusterIP 10.x.x.x
curl -fsS https://gateway.example.com/health
```

The `/health` endpoint returns `{"status":"ok","service":"x402-gateway",…}` —
it is deliberately excluded from the global `api/v1` prefix so load
balancers and probes can hit it directly.

## Operations notes

- **Rolling upgrades**: the gateway/dashboard Deployments use
  `RollingUpdate` with `maxUnavailable: 0`, so a misconfigured image won't
  take the service down; the startup probe allows up to ~5 minutes for boot.
- **Data persistence**: Postgres (10Gi) and Redis (1Gi) use
  `volumeClaimTemplates` — PVCs survive pod rescheduling. Delete the
  StatefulSets with `kubectl delete -k …` if you intend to destroy data.
- **Secrets rotation**: update `stringData` and `kubectl apply`; Deployments
  pick up the change after a rollout restart (`kubectl -n x402 rollout restart deployment/gateway`).
- **Scaling**: bump `replicas` on the gateway Deployment for more
  throughput. Redis/Postgres remain single-replica; for HA use the managed
  equivalents (RDS, ElastiCache) and point `DATABASE_URL`/`REDIS_URL` at them.
- **Mainnet**: flip `STELLAR_NETWORK` to `mainnet` in `configmap.yaml`, set
  the mainnet `USDC_ISSUER` / contract IDs, and use a strong
  `CONTRACT_ADMIN_SECRET`. See `docker-compose.mainnet.yml` for the mainnet
  variable set.
