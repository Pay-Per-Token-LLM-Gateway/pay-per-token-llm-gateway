'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorStateProps {
  title?: string;
  error?: Error | null | unknown;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = 'An error occurred',
  error,
  onRetry,
  className = '',
}: ErrorStateProps) {
  const errorMessage = error instanceof Error ? error.message : String(error || 'Unknown error');
  const isUnauthenticated = errorMessage.includes('401');

  return (
    <div
      className={`card ${isUnauthenticated ? 'border-yellow-800/30 bg-yellow-950/10' : 'border-red-800/30 bg-red-950/10'} ${className}`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`p-2 rounded-lg shrink-0 ${isUnauthenticated ? 'bg-yellow-900/20' : 'bg-red-900/20'}`}
        >
          <AlertTriangle
            className={`w-5 h-5 ${isUnauthenticated ? 'text-yellow-400' : 'text-red-400'}`}
          />
        </div>
        <div className="flex-1">
          <h3 className={`font-medium ${isUnauthenticated ? 'text-yellow-400' : 'text-red-400'}`}>
            {isUnauthenticated ? 'Authentication required' : title}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {isUnauthenticated
              ? 'Your session has expired or you are not logged in. Please connect your wallet to continue.'
              : errorMessage}
          </p>
          {isUnauthenticated ? (
            <a
              href="/login"
              className="inline-flex items-center gap-1.5 mt-2 text-sm bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg transition-colors"
            >
              Connect Wallet
            </a>
          ) : onRetry ? (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 mt-2 text-sm text-green-400 hover:text-green-300 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
