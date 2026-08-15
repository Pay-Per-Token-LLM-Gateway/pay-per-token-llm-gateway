'use client';

import { useEffect } from 'react';
import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { reset: resetQueries } = useQueryErrorResetBoundary();

  useEffect(() => {
    console.error('Dashboard error boundary caught:', error);
  }, [error]);

  const handleRetry = () => {
    // Clear react-query's failed cache so the retry re-fetches instead of
    // immediately re-throwing the cached error.
    resetQueries();
    reset();
  };

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="flex flex-col items-center gap-5 max-w-lg w-full">
        <img
          src="/icon.svg"
          alt="x402 Logo"
          className="w-16 h-16 rounded-xl shadow-lg shadow-red-500/20 opacity-80"
        />
        <div className="card w-full border-red-800/30 bg-red-950/10 text-center">
          <div className="flex flex-col items-center gap-3">
            <div className="p-3 bg-red-900/20 rounded-xl">
              <AlertTriangle className="w-6 h-6 text-red-400" />
            </div>
            <h2 className="text-lg font-semibold text-red-400">Something went wrong</h2>
            <p className="text-sm text-muted-foreground">
              {error.message || 'An unexpected error occurred. Please try again.'}
            </p>
            {error.digest && (
              <p className="text-xs text-muted-foreground font-mono">Error ID: {error.digest}</p>
            )}
            <button
              onClick={handleRetry}
              className="inline-flex items-center gap-2 mt-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Try Again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
