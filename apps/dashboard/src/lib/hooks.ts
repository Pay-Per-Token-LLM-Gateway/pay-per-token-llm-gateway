'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchProviders,
  fetchAnalyticsSummary,
  fetchTimeSeries,
  fetchPayments,
  fetchRoutes,
  fetchAuditLogs,
  createRoute,
  updateRoute,
  deleteRoute,
  createProvider,
  updateProvider,
  type ProviderResponse,
  type RouteResponse,
  type AnalyticsSummary,
  type TimeSeriesPoint,
  type PaginatedPayments,
  type PaginatedAuditLogs,
  fetchEscrowBalance,
  fetchEscrowUsage,
  type EscrowBalanceResponse,
  type EscrowUsageResponse,
} from './api';

// ── Query Key Factory ────────────────────────

export const queryKeys = {
  provider: ['provider'] as const,
  analytics: (providerId?: string) => ['analytics', 'summary', providerId] as const,
  payments: (params?: { page?: number; limit?: number; status?: string }) =>
    ['payments', params] as const,
  routes: (providerId?: string) => ['routes', providerId] as const,
  auditLogs: (params?: { page?: number; limit?: number }) => ['auditLogs', params] as const,
  escrowBalance: ['escrow', 'balance'] as const,
  escrowUsage: ['escrow', 'usage'] as const,
};

// ── Provider ──────────────────────────────────

export function useProvider() {
  return useQuery<ProviderResponse | null>({
    queryKey: queryKeys.provider,
    queryFn: async () => {
      const providers = await fetchProviders();
      return providers.length > 0 ? providers[0] : null;
    },
    staleTime: 5 * 60_000, // 5 minutes — provider config rarely changes
  });
}

export function useEscrowBalance() {
  return useQuery<EscrowBalanceResponse>({
    queryKey: queryKeys.escrowBalance,
    queryFn: fetchEscrowBalance,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function useEscrowUsage() {
  return useQuery<EscrowUsageResponse>({
    queryKey: queryKeys.escrowUsage,
    queryFn: fetchEscrowUsage,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

// ── Analytics ─────────────────────────────────

export function useAnalytics(providerId?: string) {
  return useQuery<AnalyticsSummary>({
    queryKey: queryKeys.analytics(providerId),
    queryFn: () => fetchAnalyticsSummary(providerId),
    staleTime: 30_000,
    refetchInterval: 60_000, // auto-refresh every minute
  });
}

export function useTimeSeries(
  providerId?: string,
  intervalMinutes?: number,
  durationHours?: number,
) {
  return useQuery<TimeSeriesPoint[]>({
    queryKey: ['analytics', 'timeseries', providerId, intervalMinutes, durationHours] as const,
    queryFn: () => fetchTimeSeries(providerId!, intervalMinutes, durationHours),
    enabled: !!providerId,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

// ── Payments (paginated) ──────────────────────

export function usePayments(params?: { page?: number; limit?: number; status?: string }) {
  return useQuery<PaginatedPayments>({
    queryKey: queryKeys.payments(params),
    queryFn: () => fetchPayments(params),
    placeholderData: (prev) => prev, // keep old data while fetching new page
  });
}

// ── Routes ────────────────────────────────────

export function useRoutes(providerId?: string) {
  return useQuery<RouteResponse[]>({
    queryKey: queryKeys.routes(providerId),
    queryFn: () => fetchRoutes(providerId),
    staleTime: 30_000,
  });
}

// ── Route Mutations ───────────────────────────

export function useCreateRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createRoute,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routes'] });
    },
  });
}

export function useUpdateRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<RouteResponse> }) =>
      updateRoute(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routes'] });
    },
  });
}

export function useDeleteRoute() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteRoute,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routes'] });
    },
  });
}

// ── Audit Logs (paginated) ────────────────────

export function useAuditLogs(params?: { page?: number; limit?: number }) {
  return useQuery<PaginatedAuditLogs>({
    queryKey: queryKeys.auditLogs(params),
    queryFn: () => fetchAuditLogs(params),
    placeholderData: (prev) => prev,
  });
}

// ── Provider Mutations ────────────────────────

export function useSaveProvider() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      id?: string;
      name: string;
      walletAddress: string;
      payoutWalletAddress?: string;
    }) => {
      if (data.id) {
        return updateProvider(data.id, {
          name: data.name,
          walletAddress: data.walletAddress,
          ...(data.payoutWalletAddress && { payoutWalletAddress: data.payoutWalletAddress }),
        });
      }
      return createProvider({
        name: data.name,
        walletAddress: data.walletAddress,
        ...(data.payoutWalletAddress && { payoutWalletAddress: data.payoutWalletAddress }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.provider });
    },
  });
}
