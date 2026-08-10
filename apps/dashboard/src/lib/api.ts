/**
 * Gateway API client.
 * Calls the NestJS gateway directly (CORS is configured for dashboard origin).
 */
const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:3000';
const BASE = `${GATEWAY_URL}/api/v1`;

/** Get the stored session token */
function getSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('x402-session-token');
}

/** Store the session token */
export function setSessionToken(token: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('x402-session-token', token);
  }
}

/** Clear the session token */
export function clearSessionToken(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('x402-session-token');
    localStorage.removeItem('x402-wallet-address');
  }
}

/** Store the connected wallet address */
export function setWalletAddress(address: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('x402-wallet-address', address);
  }
}

/** Get the stored wallet address */
export function getWalletAddress(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('x402-wallet-address');
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options?.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gateway error ${res.status}: ${body}`);
  }

  return res.json();
}

// ── Auth ────────────────────────────────────

export interface ChallengeResponse {
  challengeId: string;
  challenge: string;
}

export interface VerifyResponse {
  token: string;
}

export interface SessionResponse {
  address: string;
  sessionId: string;
}

export function requestChallenge(address: string): Promise<ChallengeResponse> {
  return request<ChallengeResponse>('/auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ address }),
  });
}

export function verifyChallenge(
  challengeId: string,
  address: string,
  signature: string,
): Promise<VerifyResponse> {
  return request<VerifyResponse>('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, address, signature }),
  });
}

export function validateSession(): Promise<SessionResponse> {
  return request<SessionResponse>('/auth/session');
}

export function endSession(): Promise<void> {
  return request<void>('/auth/session', { method: 'DELETE' });
}

// ── Payments ────────────────────────────────

export interface PaymentResponse {
  id: string;
  quoteId: string;
  txHash: string | null;
  payerAddress: string | null;
  amount: string;
  asset: string;
  status: string;
  verifiedAt: string | null;
  routeId: string;
  providerId: string;
  createdAt: string;
}

export interface PaginatedPayments {
  data: PaymentResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function fetchPayments(params?: {
  providerId?: string;
  status?: string;
  payerAddress?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedPayments> {
  const qs = new URLSearchParams();
  if (params?.providerId) qs.set('providerId', params.providerId);
  if (params?.status) qs.set('status', params.status);
  if (params?.payerAddress) qs.set('payerAddress', params.payerAddress);
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return request<PaginatedPayments>(`/payments${query ? `?${query}` : ''}`);
}

// ── Routes ───────────────────────────────────

export interface RouteResponse {
  id: string;
  providerId: string;
  path: string;
  upstreamUrl: string;
  loadBalancing?: LoadBalancingConfig;
  model: string;
  pricingModel: 'flat' | 'per_token';
  flatPrice?: string;
  perTokenPrice?: string;
  acceptedAssets: string[];
  rateLimit: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoadBalancedUpstream {
  url: string;
  name?: string;
  weight?: number;
  apiKeyEnv?: string;
  healthCheckUrl?: string;
}

export interface LoadBalancingConfig {
  strategy: 'round_robin' | 'least_latency';
  upstreams: LoadBalancedUpstream[];
  failureThreshold?: number;
  cooldownMs?: number;
}

export function fetchRoutes(providerId?: string): Promise<RouteResponse[]> {
  return request<RouteResponse[]>(`/routes${providerId ? `?providerId=${providerId}` : ''}`);
}

export function createRoute(data: {
  providerId: string;
  path: string;
  upstreamUrl: string;
  loadBalancing?: LoadBalancingConfig;
  model: string;
  pricingModel: 'flat' | 'per_token';
  flatPrice?: string;
  perTokenPrice?: string;
  acceptedAssets?: string[];
  rateLimit?: number;
}): Promise<RouteResponse> {
  return request<RouteResponse>('/routes', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateRoute(id: string, data: Partial<RouteResponse>): Promise<RouteResponse> {
  return request<RouteResponse>(`/routes/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteRoute(id: string): Promise<void> {
  return request<void>(`/routes/${id}`, { method: 'DELETE' });
}

// ── Analytics ────────────────────────────────

export interface AnalyticsSummary {
  totalRequests: number;
  paidRequests: number;
  unpaidRequests: number;
  totalRevenue: string;
  revenueAsset: string;
  averageResponseTime: number;
  successRate: number;
  topCallers: Array<{ address: string; totalSpent: string; requestCount: number }>;
  topRoutes: Array<{ path: string; requestCount: number; revenue: string }>;
}

export interface TimeSeriesPoint {
  timestamp: string;
  paidRequests: number;
  unpaidRequests: number;
  revenue: string;
  failedVerifications: number;
}

export function fetchAnalyticsSummary(providerId?: string): Promise<AnalyticsSummary> {
  return request<AnalyticsSummary>(
    `/analytics/summary${providerId ? `?providerId=${providerId}` : ''}`,
  );
}

export function fetchTimeSeries(
  providerId: string,
  intervalMinutes?: number,
  durationHours?: number,
): Promise<TimeSeriesPoint[]> {
  const qs = new URLSearchParams({ providerId });
  if (intervalMinutes) qs.set('intervalMinutes', String(intervalMinutes));
  if (durationHours) qs.set('durationHours', String(durationHours));
  return request<TimeSeriesPoint[]>(`/analytics/timeseries?${qs.toString()}`);
}

// ── Admin / Audit ────────────────────────────

export interface AuditLogEntry {
  id: string;
  action: string;
  entity: string;
  entityId?: string;
  actor?: string;
  details?: Record<string, unknown>;
  ip?: string;
  createdAt: string;
}

export interface PaginatedAuditLogs {
  data: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function fetchAuditLogs(params?: {
  page?: number;
  limit?: number;
  action?: string;
  entity?: string;
}): Promise<PaginatedAuditLogs> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.action) qs.set('action', params.action);
  if (params?.entity) qs.set('entity', params.entity);
  const query = qs.toString();
  return request<PaginatedAuditLogs>(`/admin/audit${query ? `?${query}` : ''}`);
}

export interface LoadBalancerRouteHealth {
  routeId: string;
  providerId: string;
  path: string;
  model: string;
  strategy: 'round_robin' | 'least_latency';
  upstreams: Array<{
    id: string;
    url: string;
    name?: string;
    weight: number;
    healthy: boolean;
    circuitOpen: boolean;
    failures: number;
    requestCount: number;
    averageLatencyMs: number;
    lastLatencyMs?: number;
    lastError?: string;
    lastCheckedAt?: string;
  }>;
}

export function fetchLoadBalancerHealth(): Promise<LoadBalancerRouteHealth[]> {
  return request<LoadBalancerRouteHealth[]>('/admin/load-balancer');
}

// ── Webhooks ─────────────────────────────────

export function sendWebhookTest(webhookUrl: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/webhooks/test', {
    method: 'POST',
    body: JSON.stringify({ webhookUrl }),
  });
}

// ── Providers ────────────────────────────────

export interface ProviderResponse {
  id: string;
  name: string;
  walletAddress: string;
  payoutWalletAddress?: string;
  webhookUrl?: string;
  active: boolean;
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export function fetchProviders(): Promise<ProviderResponse[]> {
  return request<ProviderResponse[]>('/providers');
}

export function createProvider(data: {
  name: string;
  payoutWalletAddress?: string;
  webhookUrl?: string;
  webhookSecret?: string;
}): Promise<ProviderResponse> {
  return request<ProviderResponse>('/providers', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateProvider(
  id: string,
  data: Partial<ProviderResponse> & { webhookSecret?: string },
): Promise<ProviderResponse> {
  return request<ProviderResponse>(`/providers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
