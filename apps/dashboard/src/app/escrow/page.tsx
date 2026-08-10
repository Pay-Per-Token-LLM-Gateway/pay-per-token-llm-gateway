'use client';

import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useEscrowBalance, useEscrowUsage } from '@/lib/hooks';

export default function EscrowPage() {
  const balance = useEscrowBalance();
  const usage = useEscrowUsage();

  if (balance.isError || usage.isError) {
    const error = (balance.error || usage.error) as Error;
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Credit Escrow</h1>
          <p className="text-muted-foreground mt-1">Prepaid balance and usage charged by Soroban</p>
        </div>
        <div className="card border-red-800/30 bg-red-950/10 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 mt-0.5" />
          <div>
            <p className="font-medium text-red-400">Unable to load escrow data</p>
            <p className="text-sm text-muted-foreground mt-1">{error.message}</p>
            <button
              onClick={() => {
                void balance.refetch();
                void usage.refetch();
              }}
              className="inline-flex items-center gap-1.5 mt-3 text-sm text-green-400 hover:text-green-300"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (balance.isLoading || usage.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-8 h-8 text-green-400 animate-spin" />
      </div>
    );
  }

  const events = usage.data?.usage ?? [];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Credit Escrow</h1>
        <p className="text-muted-foreground mt-1">Prepaid balance and usage charged by Soroban</p>
      </div>

      <div className="card">
        <p className="text-sm text-muted-foreground">Available balance</p>
        <p className="text-3xl font-bold font-mono text-green-400 mt-2">
          {balance.data?.balance ?? '0'}
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          {balance.data?.configured
            ? 'Escrow is configured'
            : 'Escrow is not configured on this gateway'}
        </p>
      </div>

      <div className="card overflow-hidden">
        <h2 className="font-semibold mb-4">Usage history</h2>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No escrow charges yet</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground uppercase">
                <th className="py-3 px-4">Quote</th>
                <th className="py-3 px-4">Amount</th>
                <th className="py-3 px-4">Time</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr
                  key={`${event.quoteId}-${event.timestamp}`}
                  className="border-b border-border last:border-0"
                >
                  <td className="py-3 px-4 font-mono text-sm">{event.quoteId}</td>
                  <td className="py-3 px-4 font-mono text-sm">{event.amount}</td>
                  <td className="py-3 px-4 text-sm text-muted-foreground">
                    {event.timestamp ? new Date(event.timestamp * 1000).toLocaleString() : '—'}
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
