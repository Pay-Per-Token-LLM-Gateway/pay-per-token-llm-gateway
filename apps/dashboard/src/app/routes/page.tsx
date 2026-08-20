'use client';

import { Plus, Trash2, Power, AlertTriangle, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useProvider, useRoutes, useUpdateRoute, useDeleteRoute } from '@/lib/hooks';
import type { RouteResponse } from '@/lib/api';
import { ErrorState } from '@/components/shared/ErrorState';
import { TableSkeleton, CardSkeleton } from '@/components/shared/Skeleton';

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

  if (isError) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Routes</h1>
            <p className="text-muted-foreground mt-1">Manage protected LLM endpoints and pricing</p>
          </div>
        </div>
        <ErrorState title="Failed to load routes" error={error} onRetry={() => refetch()} />
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
      {mutationError && <ErrorState title="Operation failed" error={mutationError} />}

      {/* Add Route Form */}
      {showAdd && (
        <AddRouteForm onCreated={() => setShowAdd(false)} onCancel={() => setShowAdd(false)} />
      )}

      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={5} cols={6} />
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
                  className="border-b border-border last:border-0 hover:bg-gray-800/30 transition-colors"
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
                        className="p-1.5 hover:bg-gray-700 rounded transition-colors disabled:opacity-50"
                        title={route.active ? 'Deactivate' : 'Activate'}
                      >
                        <Power className="w-4 h-4" />
                      </button>
                      <button
                        className="p-1.5 hover:bg-red-900/30 rounded transition-colors text-red-400 disabled:opacity-50"
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
  const {
    data: provider,
    isLoading: providerLoading,
    isError: providerError,
    refetch,
  } = useProvider();
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
    return <CardSkeleton />;
  }

  if (providerError) {
    return (
      <div className="card">
        <ErrorState
          title="Failed to load provider"
          error={providerError}
          onRetry={() => refetch()}
        />
        <button onClick={onCancel} className="mt-2 text-sm text-green-400 hover:underline">
          Go back
        </button>
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="card">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-yellow-900/20 rounded-lg shrink-0 mt-0.5">
            <AlertTriangle className="w-5 h-5 text-yellow-400" />
          </div>
          <div>
            <h3 className="font-medium text-yellow-400">No Provider Configured</h3>
            <p className="text-sm text-muted-foreground mt-1">
              You need to set up your provider profile before creating routes.
            </p>
            <a
              href="/settings"
              className="inline-block mt-2 text-sm text-green-400 hover:underline"
            >
              Go to Settings →
            </a>
          </div>
        </div>
        <div className="mt-4">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-gray-800 transition-colors"
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
      <div className="flex items-center gap-2 mb-4 p-3 bg-gray-900/50 rounded-lg border border-border">
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

      {(formError || createMutation.isError) && (
        <ErrorState title="Form Error" error={formError || createMutation.error} className="mb-4" />
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-sm mb-1">Path</label>
          <input
            name="path"
            required
            className="w-full px-3 py-2 bg-gray-800 border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500/50"
            placeholder="/v1/chat/completions"
          />
        </div>
        <div>
          <label className="block text-sm mb-1">Upstream URL</label>
          <input
            name="upstreamUrl"
            required
            className="w-full px-3 py-2 bg-gray-800 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
            placeholder="https://api.openai.com/v1/chat/completions"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm mb-1">Model</label>
            <input
              name="model"
              required
              className="w-full px-3 py-2 bg-gray-800 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
              placeholder="gpt-4"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">Pricing Model</label>
            <select
              name="pricingModel"
              value={pricingModel}
              onChange={(e) => setPricingModel(e.target.value as 'flat' | 'per_token')}
              className="w-full px-3 py-2 bg-gray-800 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
            >
              <option value="flat">Flat</option>
              <option value="per_token">Per Token</option>
            </select>
          </div>
        </div>

        {pricingModel === 'flat' ? (
          <div>
            <label className="block text-sm mb-1">Flat Price (USDC)</label>
            <input
              name="flatPrice"
              type="number"
              step="0.000001"
              required
              className="w-full px-3 py-2 bg-gray-800 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
              placeholder="1.0"
            />
          </div>
        ) : (
          <div>
            <label className="block text-sm mb-1">Price Per 1k Tokens (USDC)</label>
            <input
              name="perTokenPrice"
              type="number"
              step="0.000001"
              required
              className="w-full px-3 py-2 bg-gray-800 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
              placeholder="0.01"
            />
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="flex-1 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors text-sm font-medium disabled:opacity-50"
          >
            {createMutation.isPending ? 'Adding...' : 'Add Route'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
