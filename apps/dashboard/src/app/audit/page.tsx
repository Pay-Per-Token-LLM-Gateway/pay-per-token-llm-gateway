'use client';

import { Shield, FileText, RefreshCw, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useAuditLogs } from '@/lib/hooks';
import { ErrorState } from '@/components/shared/ErrorState';
import { Skeleton } from '@/components/shared/Skeleton';

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error, isFetching, refetch } = useAuditLogs({
    page,
    limit: 50,
  });

  const logs = data?.data ?? [];

  if (isError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Audit Log</h1>
          <p className="text-muted-foreground mt-1">Complete record of all gateway operations</p>
        </div>
        <ErrorState title="Failed to load audit logs" error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Audit Log</h1>
        <p className="text-muted-foreground mt-1">Complete record of all gateway operations</p>
      </div>

      <div className="card">
        {isLoading ? (
          <div className="space-y-4 py-4 px-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="flex items-start gap-4 pb-4 border-b border-border last:pb-0 last:border-0"
              >
                <Skeleton className="w-8 h-8 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <div className="p-3 bg-gray-800 rounded-full">
              <FileText className="w-8 h-8 text-gray-500" />
            </div>
            <div className="text-center max-w-sm">
              <h3 className="font-medium text-gray-300">No audit log entries yet</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Audit logs are created automatically when payments are verified, requests are
                forwarded, and providers are registered. They&apos;ll appear here once your gateway
                processes its first requests.
              </p>
            </div>
          </div>
        ) : (
          <>
            {isFetching && <div className="h-0.5 bg-green-500/50 animate-pulse mb-4" />}
            <div className="space-y-4">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-start gap-4 pb-4 border-b border-border last:pb-0 last:border-0"
                >
                  <div className="p-2 bg-gray-800 rounded-lg shrink-0">
                    <Shield className="w-4 h-4 text-green-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm">{log.action}</span>
                      <span className="badge badge-blue text-xs">{log.entity}</span>
                      {log.entityId && (
                        <span className="text-xs text-muted-foreground font-mono">
                          {log.entityId.slice(0, 8)}...
                        </span>
                      )}
                    </div>
                    {log.details && (
                      <p className="text-sm text-muted-foreground">
                        {JSON.stringify(log.details).slice(0, 120)}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-muted-foreground">
                        by {log.actor || 'system'}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(log.createdAt).toLocaleString()}
                      </span>
                      {log.ip && (
                        <span className="text-xs text-muted-foreground">IP: {log.ip}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {data && data.totalPages > 1 && (
              <div className="flex items-center justify-between pt-4 mt-4 border-t border-border">
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
