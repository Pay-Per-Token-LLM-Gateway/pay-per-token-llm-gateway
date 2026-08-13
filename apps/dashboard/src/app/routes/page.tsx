'use client';

import { Plus, Trash2, Power, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import {
  useProvider,
  useRoutes,
  useCreateRoute,
  useUpdateRoute,
  useDeleteRoute,
} from '@/lib/hooks';
import type { RouteResponse } from '@/lib/api';

export default function RoutesPage() {
  const [showAdd, setShowAdd] = useState(false);
  const { data: routes, isLoading, isError, error, refetch } = useRoutes();
  const deleteMutation = useDeleteRoute();
  const updateMutation = useUpdateRoute();

  const handleToggleActive = (route: RouteResponse) => {
    updateMutation.mutate({
      id: route.id,
      data: { active: !route.active },
    });
  };

  const handleDelete = (id: string) => {
    if (!confirm('Delete this route?')) return;
    deleteMutation.mutate(id);
  };

  const isUnauthenticated = (error as Error)?.message?.includes('401');

  if (isError) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Routes</h1>
            <p className="text-muted-foreground mt-1">Manage protected LLM endpoints and pricing</p>
          </div>
        </div>
        <div
          className={`card ${isUnauthenticated ? 'border-yellow-300/60 bg-yellow-50 dark:border-yellow-800/30 dark:bg-yellow-950/10' : 'border-red-300/60 bg-red-50 dark:border-red-800/30 dark:bg-red-950/10'}`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`p-2 rounded-lg shrink-0 ${isUnauthenticated ? 'bg-yellow-100 dark:bg-yellow-900/20' : 'bg-red-100 dark:bg-red-900/20'}`}
            >
              <AlertTriangle
                className={`w-5 h-5 ${isUnauthenticated ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}
              />
            </div>
            <div className="flex-1">
              <h3
                className={`font-medium ${isUnauthenticated ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}
              >
                {isUnauthenticated ? 'Authentication required' : 'Failed to load routes'}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                {isUnauthenticated
                  ? 'Your session has expired or you are not logged in. Please connect your wallet to continue.'
                  : (error as Error).message}
              </p>
              {isUnauthenticated ? (
                <a
                  href="/login"
                  className="inline-flex items-center gap-1.5 mt-2 text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg transition-colors"
                >
                  Connect Wallet
                </a>
              ) : (
                <button
                  onClick={() => refetch()}
                  className="inline-flex items-center gap-1.5 mt-2 text-sm text-green-600 dark:text-green-400 hover:text-green-300 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Retry
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const mutationError =
    (deleteMutation.error as Error)?.message || (updateMutation.error as Error)?.message;

  const routeList = routes ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Routes</h1>
          <p className="text-muted-foreground mt-1">Manage protected LLM endpoints and pricing</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" /> Add Route
        </button>
      </div>

      {/* Mutation errors */}
      {mutationError && (
        <div className="card border-red-300/60 bg-red-50 dark:border-red-800/30 dark:bg-red-950/10">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-red-100 dark:bg-red-900/20 rounded-lg shrink-0">
              <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400" />
            </div>
            <div className="flex-1">
              <h3 className="font-medium text-red-600 dark:text-red-400">Operation failed</h3>
              <p className="text-sm text-muted-foreground mt-1">{mutationError}</p>
            </div>
          </div>
        </div>
      )}

      {/* Add Route Form */}
      {showAdd && (
        <AddRouteForm onCreated={() => setShowAdd(false)} onCancel={() => setShowAdd(false)} />
      )}

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-8 h-8 text-green-600 dark:text-green-400 animate-spin" />
            <p className="text-sm text-muted-foreground">Loading routes...</p>
          </div>
        ) : routeList.length === 0 ? (
          <p className="text-muted-foreground text-sm py-8 text-center">
            No routes configured. Add your first route.
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                  Path
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                  Model
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                  Pricing
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                  Price
                </th>
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                  Status
                </th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {routeList.map((route) => (
                <tr
                  key={route.id}
                  className="border-b border-border last:border-0 hover:bg-muted/40 transition-colors"
                >
                  <td className="py-3 px-4 font-mono text-sm">{route.path}</td>
                  <td className="py-3 px-4 text-sm">{route.model}</td>
                  <td className="py-3 px-4">
                    <span
                      className={`badge ${route.pricingModel === 'flat' ? 'badge-blue' : 'badge-green'}`}
                    >
                      {route.pricingModel === 'flat' ? 'Flat' : 'Per Token'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-sm font-mono">
                    {route.pricingModel === 'flat' ? route.flatPrice : route.perTokenPrice}{' '}
                    {route.acceptedAssets?.[0] ?? 'USDC'}
                  </td>
                  <td className="py-3 px-4">
                    <span className={`badge ${route.active ? 'badge-green' : 'badge-red'}`}>
                      {route.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleToggleActive(route)}
                        disabled={updateMutation.isPending}
                        className="p-1.5 hover:bg-muted rounded transition-colors disabled:opacity-50"
                        title={route.active ? 'Deactivate' : 'Activate'}
                      >
                        <Power className="w-4 h-4" />
                      </button>
                      <button
                        className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors text-red-600 dark:text-red-400 disabled:opacity-50"
                        disabled={deleteMutation.isPending}
                        onClick={() => handleDelete(route.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function AddRouteForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const { data: provider, isLoading: providerLoading, isError: providerError } = useProvider();
  const createMutation = useCreateRoute();
  const [formError, setFormError] = useState<string | null>(null);
  const [pricingModel, setPricingModel] = useState<'flat' | 'per_token'>('flat');

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!provider) {
      setFormError('No provider configured. Set up your provider in Settings first.');
      return;
    }

    setFormError(null);
    const form = e.currentTarget;
    const formData = new FormData(form);

    createMutation.mutate(
      {
        providerId: provider.id,
        path: formData.get('path') as string,
        upstreamUrl: formData.get('upstreamUrl') as string,
        model: formData.get('model') as string,
        pricingModel: (formData.get('pricingModel') as 'flat' | 'per_token') || 'flat',
        flatPrice: (formData.get('flatPrice') as string) || undefined,
        perTokenPrice: (formData.get('perTokenPrice') as string) || undefined,
        acceptedAssets: ['USDC'],
        rateLimit: 10,
      },
      {
        onSuccess: () => onCreated(),
        onError: (err) => setFormError((err as Error).message),
      },
    );
  };

  if (providerLoading) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-4 gap-3">
          <Loader2 className="w-5 h-5 text-green-600 dark:text-green-400 animate-spin" />
          <p className="text-sm text-muted-foreground">Loading provider info...</p>
        </div>
      </div>
    );
  }

  if (providerError) {
    return (
      <div className="card">
        <p className="text-red-600 dark:text-red-400 text-sm">Failed to load provider.</p>
        <button
          onClick={onCancel}
          className="mt-2 text-sm text-green-600 dark:text-green-400 hover:underline"
        >
          Go back
        </button>
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="card">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-yellow-100 dark:bg-yellow-900/20 rounded-lg shrink-0 mt-0.5">
            <svg
              className="w-5 h-5 text-yellow-600 dark:text-yellow-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
          </div>
          <div>
            <h3 className="font-medium text-yellow-600 dark:text-yellow-400">
              No Provider Configured
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              You need to set up your provider profile before creating routes.
            </p>
            <a
              href="/settings"
              className="inline-block mt-2 text-sm text-green-600 dark:text-green-400 hover:underline"
            >
              Go to Settings →
            </a>
          </div>
        </div>
        <div className="mt-4">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="text-lg font-semibold mb-4">Add New Route</h2>

      {/* Provider context badge */}
      <div className="flex items-center gap-2 mb-4 p-3 bg-muted/40 rounded-lg border border-border">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500 to-blue-600 flex items-center justify-center shrink-0">
          <span className="text-white font-bold text-xs">
            {provider.name.charAt(0).toUpperCase()}
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{provider.name}</p>
          <p className="text-xs text-muted-foreground font-mono truncate">
            {provider.id.slice(0, 12)}...
          </p>
        </div>
        <span className="badge badge-green text-xs ml-auto shrink-0">Active</span>
      </div>

      {formError && <p className="text-red-600 dark:text-red-400 text-sm mb-3">{formError}</p>}
      {createMutation.isError && !formError && (
        <p className="text-red-600 dark:text-red-400 text-sm mb-3">
          {(createMutation.error as Error).message}
        </p>
      )}
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-sm mb-1">Path</label>
          <input
            name="path"
            required
            className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500/50"
            placeholder="/v1/chat/completions"
          />
        </div>
        <div>
          <label className="block text-sm mb-1">Upstream URL</label>
          <input
            name="upstreamUrl"
            required
            className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
            placeholder="https://api.openai.com/v1/chat/completions"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm mb-1">Model</label>
            <input
              name="model"
              required
              className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
              placeholder="gpt-4"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">Pricing Model</label>
            <select
              name="pricingModel"
              value={pricingModel}
              onChange={(e) => setPricingModel(e.target.value as 'flat' | 'per_token')}
              className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
            >
              <option value="flat">Flat</option>
              <option value="per_token">Per Token</option>
            </select>
          </div>
        </div>

        {/* Price fields — show/hide based on pricing model */}
        <div className="space-y-3 transition-all duration-200">
          {pricingModel === 'flat' && (
            <div>
              <label className="block text-sm mb-1">
                Flat Price{' '}
                <span className="text-xs text-muted-foreground">
                  (smallest unit, e.g. 1000000 = 0.1 USDC)
                </span>
              </label>
              <div className="relative">
                <input
                  name="flatPrice"
                  required
                  className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500/50"
                  placeholder="1000000"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  stroops
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Charged once per request regardless of token usage
              </p>
            </div>
          )}

          {pricingModel === 'per_token' && (
            <div>
              <label className="block text-sm mb-1">
                Per-Token Price{' '}
                <span className="text-xs text-muted-foreground">
                  (smallest unit, e.g. 100 = 0.00001 USDC per token)
                </span>
              </label>
              <div className="relative">
                <input
                  name="perTokenPrice"
                  required
                  className="w-full px-3 py-2 bg-muted/50 border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500/50"
                  placeholder="100"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  stroops/token
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Charged per token — total cost = tokens used × this rate
              </p>
            </div>
          )}
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="px-4 py-2 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {createMutation.isPending ? 'Saving...' : 'Create Route'}
          </button>
        </div>
      </form>
    </div>
  );
}
