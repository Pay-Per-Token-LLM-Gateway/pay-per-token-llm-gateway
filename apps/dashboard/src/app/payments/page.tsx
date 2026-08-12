'use client';

import { ExternalLink, Copy, Check, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { usePayments } from '@/lib/hooks';
import { ErrorState } from '@/components/error-state';

export default function PaymentsPage() {
  const [page, setPage] = useState(1);
  const [copied, setCopied] = useState<string | null>(null);
  const { data, isLoading, isError, error, isFetching, refetch } = usePayments({ page, limit: 20 });

  const copyTxHash = (hash: string | null) => {
    if (!hash) return;
    if (typeof navigator !== 'undefined') {
      navigator.clipboard.writeText(hash);
    }
    setCopied(hash);
    setTimeout(() => setCopied(null), 2000);
  };

  if (isError) {
    const isUnauthenticated = (error as Error).message?.includes('401');
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Payments</h1>
          <p className="text-muted-foreground mt-1">
            All payment transactions processed by the gateway
          </p>
        </div>
        <ErrorState
          title={isUnauthenticated ? 'Authentication required' : 'Failed to load payments'}
          message={
            isUnauthenticated
              ? 'Your session has expired or you are not logged in.'
              : (error as Error).message
          }
          onRetry={() => refetch()}
          unauthenticated={isUnauthenticated}
        />
      </div>
    );
  }

  const payments = data?.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Payments</h1>
        <p className="text-muted-foreground mt-1">
          All payment transactions processed by the gateway
        </p>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-8 h-8 text-green-400 animate-spin" />
            <p className="text-sm text-muted-foreground">Loading payments...</p>
          </div>
        ) : payments.length === 0 ? (
          <p className="text-muted-foreground text-sm py-8 text-center">No payments yet</p>
        ) : (
          <>
            {isFetching && <div className="h-0.5 bg-green-500/50 animate-pulse" />}
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                    Transaction
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                    Payer
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                    Amount
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                    Status
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-border last:border-0 hover:bg-gray-800/30 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">
                          {p.txHash ? `${p.txHash.slice(0, 8)}...${p.txHash.slice(-6)}` : '—'}
                        </span>
                        {p.txHash && (
                          <>
                            <button
                              onClick={() => copyTxHash(p.txHash)}
                              className="hover:text-green-400 transition-colors"
                            >
                              {copied === p.txHash ? (
                                <Check className="w-3 h-3 text-green-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </button>
                            <a
                              href={`https://stellar.expert/explorer/testnet/tx/${p.txHash}`}
                              target="_blank"
                              className="hover:text-green-400 transition-colors"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-sm">
                      {p.payerAddress
                        ? `${p.payerAddress.slice(0, 6)}...${p.payerAddress.slice(-4)}`
                        : '—'}
                    </td>
                    <td className="py-3 px-4 text-sm font-mono font-medium">
                      {p.amount} {p.asset}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`badge ${p.status === 'confirmed' ? 'badge-green' : p.status === 'pending' ? 'badge-yellow' : 'badge-red'}`}
                      >
                        {p.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-sm text-muted-foreground">
                      {new Date(p.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {data && data.totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                <span className="text-sm text-muted-foreground">
                  Page {data.page} of {data.totalPages} ({data.total} total)
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1 || isFetching}
                    className="px-3 py-1 text-sm bg-gray-800 rounded disabled:opacity-50 hover:bg-gray-700 transition-colors"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page >= data.totalPages || isFetching}
                    className="px-3 py-1 text-sm bg-gray-800 rounded disabled:opacity-50 hover:bg-gray-700 transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
