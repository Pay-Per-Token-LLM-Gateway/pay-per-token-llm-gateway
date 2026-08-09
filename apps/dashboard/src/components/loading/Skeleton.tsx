'use client';

/**
 * Loading skeleton that matches the card layout used across the dashboard.
 * Renders a pulsing placeholder grid so the user sees structure while data loads.
 */
export function CardSkeleton() {
  return (
    <div className="card animate-pulse" aria-hidden="true">
      <div className="flex items-center justify-between mb-4">
        <div className="h-4 w-28 bg-gray-700 rounded" />
        <div className="h-8 w-8 bg-gray-700 rounded-lg" />
      </div>
      <div className="h-8 w-24 bg-gray-700 rounded mb-2" />
      <div className="h-3 w-32 bg-gray-700 rounded" />
    </div>
  );
}

/**
 * Skeleton for a full-page table (Routes, Payments, Audit).
 */
export function TableSkeleton({
  rows = 5,
  cols = 5,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <div className="card overflow-hidden animate-pulse" aria-hidden="true">
      {/* Table header */}
      <div className="flex gap-4 px-4 py-3 border-b border-border">
        {Array.from({ length: cols }).map((_, i) => (
          <div
            key={`h-${i}`}
            className="h-3 flex-1 bg-gray-700 rounded"
          />
        ))}
      </div>

      {/* Table rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={`r-${r}`}
          className="flex gap-4 px-4 py-4 border-b border-border last:border-0"
        >
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={`c-${c}`}
              className="h-4 flex-1 bg-gray-700/60 rounded"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Skeleton for the dashboard stats grid (4 cards).
 */
export function StatsGridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * Skeleton for the dashboard chart area.
 */
export function ChartSkeleton() {
  return (
    <div className="card animate-pulse" aria-hidden="true">
      <div className="h-5 w-32 bg-gray-700 rounded mb-4" />
      <div className="h-72 bg-gray-800 rounded-lg" />
    </div>
  );
}

/**
 * Skeleton for a list of items (e.g. top callers / routes).
 */
export function ListSkeleton({ items = 5 }: { items?: number }) {
  return (
    <div className="animate-pulse space-y-3" aria-hidden="true">
      {Array.from({ length: items }).map((_, i) => (
        <div
          key={i}
          className="flex items-center justify-between py-2 border-b border-border last:border-0"
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gray-700 rounded-full" />
            <div className="h-4 w-32 bg-gray-700 rounded" />
          </div>
          <div className="h-4 w-24 bg-gray-700 rounded" />
        </div>
      ))}
    </div>
  );
}