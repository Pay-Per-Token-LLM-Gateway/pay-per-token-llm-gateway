'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Reusable data-fetch error card (bounty #10).
 *
 * Rendered by every data-fetching dashboard page when a query fails.
 * Shows a friendly title plus the underlying error message, and an
 * optional Retry button wired to the query's `refetch`.
 *
 * When `unauthenticated` is set (a 401 from the gateway), renders the
 * auth-required variant instead: amber styling and a Connect Wallet CTA
 * instead of the Retry button.
 */
export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = 'Retry',
  unauthenticated = false,
}: {
  title: string;
  message?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  unauthenticated?: boolean;
}) {
  return (
    <div
      className={`card ${
        unauthenticated
          ? 'border-yellow-800/30 bg-yellow-950/10'
          : 'border-red-800/30 bg-red-950/10'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`p-2 rounded-lg shrink-0 ${unauthenticated ? 'bg-yellow-900/20' : 'bg-red-900/20'}`}
        >
          <AlertTriangle
            className={`w-5 h-5 ${unauthenticated ? 'text-yellow-400' : 'text-red-400'}`}
          />
        </div>
        <div className="flex-1">
          <h3 className={`font-medium ${unauthenticated ? 'text-yellow-400' : 'text-red-400'}`}>
            {title}
          </h3>
          {message && <p className="text-sm text-muted-foreground mt-1">{message}</p>}
          {unauthenticated ? (
            <a
              href="/login"
              className="inline-flex items-center gap-1.5 mt-2 text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg transition-colors"
            >
              Connect Wallet
            </a>
          ) : (
            onRetry && (
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 mt-2 text-sm text-green-400 hover:text-green-300 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" /> {retryLabel}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
