'use client';

import { Settings, Save, Loader2 } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useProvider, useSaveProvider } from '@/lib/hooks';
import { ErrorState } from '@/components/error-state';

export default function SettingsPage() {
  const { data: provider, isLoading, isError, error, refetch } = useProvider();
  const saveMutation = useSaveProvider();

  const [name, setName] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [payoutWalletAddress, setPayoutWalletAddress] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [success, setSuccess] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Sync form state on initial load only — avoids resetting edits on refetch
  useEffect(() => {
    if (provider && !initialized) {
      setName(provider.name);
      setWalletAddress(provider.walletAddress);
      setPayoutWalletAddress(provider.payoutWalletAddress || '');
      setWebhookUrl(provider.webhookUrl || '');
      setInitialized(true);
    }
  }, [provider, initialized]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setSuccess(false);

    saveMutation.mutate(
      {
        id: provider?.id,
        name,
        payoutWalletAddress: payoutWalletAddress || undefined,
        webhookUrl: webhookUrl || undefined,
        webhookSecret: webhookSecret || undefined,
      },
      {
        onSuccess: () => {
          setSuccess(true);
          setTimeout(() => setSuccess(false), 3000);
          setWebhookSecret('');
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-muted-foreground mt-1">
            Configure your provider profile and gateway preferences
          </p>
        </div>
        <div className="card max-w-2xl">
          <div className="flex items-center gap-3 py-4">
            <Loader2 className="w-5 h-5 text-green-400 animate-spin" />
            <p className="text-sm text-muted-foreground">Loading provider settings...</p>
          </div>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-muted-foreground mt-1">
            Configure your provider profile and gateway preferences
          </p>
        </div>
        <ErrorState
          title="Failed to load settings"
          message={(error as Error).message}
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Configure your provider profile and gateway preferences
        </p>
      </div>

      {saveMutation.isError && (
        <div className="card max-w-2xl border-red-800/50">
          <p className="text-red-400 text-sm">{(saveMutation.error as Error).message}</p>
        </div>
      )}

      {success && (
        <div className="card max-w-2xl border-green-800/50">
          <p className="text-green-400 text-sm">✓ Settings saved successfully</p>
        </div>
      )}

      <div className="card max-w-2xl">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Settings className="w-5 h-5" /> Provider Profile
        </h2>
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Provider Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
              placeholder="My LLM Provider"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              Payment Wallet Address (Stellar)
            </label>
            <input
              type="text"
              value={walletAddress}
              disabled
              className="w-full px-3 py-2 bg-gray-800/50 border border-border rounded-lg text-sm font-mono opacity-70 cursor-not-allowed"
              title="Locked to your authenticated wallet"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Payments go to the wallet you signed in with. This address is locked and cannot be
              changed — it is the ownership anchor for your providers.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              Payout Wallet Address (optional, for multisig)
            </label>
            <input
              type="text"
              value={payoutWalletAddress}
              onChange={(e) => setPayoutWalletAddress(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500/50"
              placeholder="G..."
              pattern="^(G[A-Z2-7]{55})?$"
              title="Enter a valid Stellar wallet address starting with G, or leave empty"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Webhook URL (optional)</label>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
              placeholder="https://your-service.com/webhook"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Receive <code>payment_received</code> and <code>verification_failed</code> events.
              Public HTTPS only.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Webhook Secret (optional)</label>
            <input
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
              placeholder="Used to sign webhooks (X-x402-Signature)"
            />
          </div>
          <button
            type="submit"
            disabled={saveMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors text-sm font-medium disabled:opacity-50"
          >
            {saveMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {saveMutation.isPending ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </div>

      {provider && (
        <div className="card max-w-2xl">
          <h2 className="text-lg font-semibold mb-2">Connection Details</h2>
          <div className="text-sm text-muted-foreground space-y-1">
            <p>
              Provider ID: <code className="bg-gray-800 px-1 rounded text-xs">{provider.id}</code>
            </p>
            <p>
              Status:{' '}
              <span className={`badge ${provider.active ? 'badge-green' : 'badge-red'}`}>
                {provider.active ? 'Active' : 'Inactive'}
              </span>
            </p>
            <p>Created: {new Date(provider.createdAt).toLocaleString()}</p>
          </div>
        </div>
      )}
    </div>
  );
}
