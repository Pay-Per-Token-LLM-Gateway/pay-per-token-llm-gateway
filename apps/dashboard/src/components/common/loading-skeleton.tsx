'use client';

import { Loader2 } from 'lucide-react';

/**
 * Full-page loading skeleton — shown while TanStack Query's `isLoading` is true.
 * Variants: 'page' (centred spinner), 'table' (table row skeleton), 'stats' (card grid).
 */
export function LoadingSkeleton({
  variant = 'page',
  rows = 5,
  cards = 4,
}: {
  variant?: 'page' | 'table' | 'stats';
  rows?: number;
  cards?: number;
}) {
  if (variant === 'table') {
    return (
      <div className="card overflow-hidden">
        <div className="space-y-0">
          {/* Header */}
          <div className="border-b border-border px-4 py-3">
            <div className="h-3 w-24 bg-gray-700 rounded animate-pulse" />
          </div>
          {/* Rows */}
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0"
            >
              <div className="h-4 w-32 bg-gray-700 rounded animate-pulse" />
              <div className="h-4 w-20 bg-gray-700 rounded animate-pulse" />
              <div className="h-4 w-16 bg-gray-700 rounded animate-pulse ml-auto" />
              <div className="h-6 w-14 bg-gray-700 rounded-full animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (variant === 'stats') {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: cards }).map((_, i) => (
          <div key={i} className="card">
            <div className="flex items-center justify-between mb-3">
              <div className="h-3 w-24 bg-gray-700 rounded animate-pulse" />
              <div className="h-8 w-8 bg-gray-700 rounded-lg animate-pulse" />
            </div>
            <div className="h-6 w-28 bg-gray-700 rounded animate-pulse mb-2" />
            <div className="h-3 w-16 bg-gray-700 rounded animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  /* page — default */
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4">
      <div className="relative">
        <div className="w-16 h-16 rounded-xl bg-gray-800 animate-pulse" />
        <Loader2 className="w-6 h-6 text-green-400 animate-spin absolute -bottom-1 -right-1" />
      </div>
      <p className="text-sm text-muted-foreground">Loading...</p>
    </div>
  );
}