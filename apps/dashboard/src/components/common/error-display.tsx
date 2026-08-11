'use client';

import { AlertTriangle, RefreshCw, ShieldAlert, WifiOff } from 'lucide-react';

interface ErrorDisplayProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  /** Categorise the error for a more specific icon and tone. */
  variant?: 'data-fetch' | 'network' | 'auth' | 'generic';
}

/**
 * Reusable error display card with contextual icon and retry button.
 * Use inside data-fetching pages that have TanStack Query's `isError` / `error` state.
 */
export function ErrorDisplay({
  title,
  message,
  onRetry,
  variant = 'generic',
}: ErrorDisplayProps) {
  const Icon = variant === 'network' ? WifiOff
    : variant === 'auth' ? ShieldAlert
    : AlertTriangle;

  const defaultTitle = variant === 'network'
    ? 'Network Error'
    : variant === 'auth'
      ? 'Authentication Failed'
      : 'Something went wrong';

  return (
    <div className="card border-red-800/30 bg-red-950/10">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-red-900/20 rounded-lg shrink-0 mt-0.5">
          <Icon className="w-5 h-5 text-red-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-red-400">{title ?? defaultTitle}</h3>
          <p className="text-sm text-muted-foreground mt-1 break-words">{message}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 mt-2 text-sm text-green-400 hover:text-green-300 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}