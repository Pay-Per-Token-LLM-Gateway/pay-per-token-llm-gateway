'use client';

import { ErrorState } from '../error/ErrorState';
import { TableSkeleton } from '../loading/Skeleton';

interface FetchStateProps<T> {
  /** react-query's isLoading — true only when no data yet and refetching. */
  isLoading: boolean;
  /** react-query's isError. */
  isError: boolean;
  /** The query error, if any. */
  error?: Error | null;
  /** Called on "Retry". */
  onRetry?: () => void;
  /** The loaded data. Renders `children` when non-null. */
  data: T | null | undefined;
  /** Skeleton rendered during initial load. */
  skeleton?: React.ReactNode;
  /** Rendered once data is available. */
  children: (data: T) => React.ReactNode;
}

/**
 * Centralized data-fetch presentation primitive.
 * Handles the loading-skeleton / error-state / success triad so every
 * data-fetching page renders consistent UX.
 */
export function FetchState<T>({
  isLoading,
  isError,
  error,
  onRetry,
  data,
  skeleton,
  children,
}: FetchStateProps<T>) {
  if (isError) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }

  if (isLoading || data === undefined || data === null) {
    return skeleton ?? <TableSkeleton />;
  }

  return <>{children(data)}</>;
}