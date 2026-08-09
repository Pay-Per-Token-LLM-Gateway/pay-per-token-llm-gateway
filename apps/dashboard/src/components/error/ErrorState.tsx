'use client';

import { AlertTriangle, RefreshCw, ShieldOff, WifiOff } from 'lucide-react';

interface ErrorStateProps {
  /** The error object, if available. */
  error?: Error | null;
  /** Called when the user clicks "Retry". */
  onRetry?: () => void;
  /** Override the default title. */
  title?: string;
  /** Override the default description. */
  description?: string;
}

/**
 * Reusable error state UI — distinguishes network errors, 401, 500, and
 * generic errors so the user gets a helpful, targeted message.
 */
export function ErrorState({
  error,
  onRetry,
  title,
  description,
}: ErrorStateProps) {
  // Inspect the error and pick an appropriate icon + message
  const { icon, themeTitle, themeDescription } = parseError(error);

  return (
    <div className="card border-red-800/30 bg-red-950/10">
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <div className="p-3 bg-red-900/20 rounded-xl">
          {icon}
        </div>

        <div className="max-w-md">
          <h3 className="font-semibold text-red-400">
            {title ?? themeTitle}
          </h3>
          <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
            {description ?? themeDescription}
          </p>
          {error?.message && (
            <p className="text-xs text-muted-foreground/60 mt-2 font-mono">
              {error.message}
            </p>
          )}
        </div>

        {onRetry && (
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────

interface ParsedTheme {
  icon: React.ReactNode;
  themeTitle: string;
  themeDescription: string;
}

function parseError(error?: Error | null): ParsedTheme {
  const status = (error as any)?.status as number | undefined;

  // Network-level failure (status 0 from our GatewayError)
  if (status === 0) {
    return {
      icon: <WifiOff className="w-6 h-6 text-red-400" />,
      themeTitle: 'Connection failed',
      themeDescription:
        'Unable to reach the gateway. Please verify the gateway is running and your network connection is available.',
    };
  }

  // 401 Unauthorized
  if (status === 401) {
    return {
      icon: <ShieldOff className="w-6 h-6 text-red-400" />,
      themeTitle: 'Session expired',
      themeDescription:
        'Your session has expired or is invalid. Please log in again to continue.',
    };
  }

  // 500+ server errors
  if (status !== undefined && status >= 500) {
    return {
      icon: <AlertTriangle className="w-6 h-6 text-red-400" />,
      themeTitle: 'Server error',
      themeDescription:
        'The gateway encountered an internal error. Please try again later.',
    };
  }

  // Fallback — generic error
  return {
    icon: <AlertTriangle className="w-6 h-6 text-red-400" />,
    themeTitle: 'Something went wrong',
    themeDescription:
      'An unexpected error occurred. Please try again.',
  };
}