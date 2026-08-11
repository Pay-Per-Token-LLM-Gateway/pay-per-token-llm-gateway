# x402 LLM Gateway — Kubernetes Deployment

This directory contains production-ready Kubernetes manifests for deploying the x402 LLM Gateway stack.

## Prerequisites

- A Kubernetes cluster (v1.24+)
- `kubectl` configured with cluster access
- An Ingress controller (e.g., [nginx-ingress](https://kubernetes.github.io/ingress-nginx/))
- (Optional) [cert-manager](https://cert-manager.io/) for automatic TLS certificates

## Quick Start

```bash
# Deploy everything
kubectl apply -k infrastructure/kubernetes/

# Wait for all pods to become ready
kubectl get pods -n x402-gateway -w
```

## Architecture

```
                  ┌──────────────┐
                  │   Ingress    │
                  │  (nginx + TLS)│
                  └──────┬───────┘
                    ┌────┴────┐
                    │         │
              ┌─────▼──┐ ┌───▼──────┐
              │ Gateway │ │ Dashboard│
              │  :3000  │ │  :3001   │
              └──┬──┬───┘ └──────────┘
                 │  │
        ┌────────▼──▼───────┐
        │ PostgreSQL  :5432 │
        │ Redis       :6379 │
        └───────────────────┘
```

## Components

| Component    | Type         | Replicas | Port | Health Probe         |
|-------------|-------------|----------|------|----------------------|
| Gateway     | Deployment  | 2        | 3000 | HTTP GET /health     |
| Dashboard   | Deployment  | 2        | 3001 | HTTP GET /            |
| PostgreSQL  | StatefulSet | 1        | 5432 | pg_isready           |
| Redis       | StatefulSet | 1        | 6379 | redis-cli ping       |

## Configuration

### Environment Variables

**Non-sensitive** config (gateway endpoint URLs, CORS, etc.) is stored in `configmap.yaml`.

**Sensitive** config (database URL, JWT secret, API keys) is stored in `secret.yaml`.

For production:

1. Generate a strong JWT secret:
   ```bash
   openssl rand -hex 64
   ```

2. Update `secret.yaml` or use the `kubectl create secret` command:
   ```bash
   kubectl create secret generic x402-secrets \
     --namespace x402-gateway \
     --from-literal=DATABASE_URL='postgresql://...' \
     --from-literal=REDIS_URL='redis://...' \
     --from-literal=JWT_SECRET='...' \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

### TLS

The ingress expects a TLS certificate secret named `x402-tls` in the `x402-gateway` namespace.
If using cert-manager, add a ClusterIssuer annotation and let it auto-provision via Let's Encrypt.

### Image Registry

By default, manifests reference local images (`pay-per-token-llm-gateway/gateway:latest`).
Override with `kustomize`:

```bash
# Edit kustomization.yaml to point to your registry
kubectl apply -k infrastructure/kubernetes/
```

## Building Images

```bash
# Gateway
docker build -f infrastructure/docker/Dockerfile.gateway -t ghcr.io/pay-per-token-llm-gateway/gateway:latest .

# Dashboard
docker build -f infrastructure/docker/Dockerfile.dashboard -t ghcr.io/pay-per-token-llm-gateway/dashboard:latest .
```

## Monitoring

- Gateway exposes `/health` for load balancer health checks (returns `{"status":"ok","service":"x402-gateway"}`)
- Prometheus metrics can be added by annotating the gateway Service with `prometheus.io/scrape: "true"`

## Cleanup

```bash
kubectl delete namespace x402-gateway
```