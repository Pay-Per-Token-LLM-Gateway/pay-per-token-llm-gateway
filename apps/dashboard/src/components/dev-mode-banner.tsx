'use client';

import { ShieldAlert } from 'lucide-react';
import { getDevWalletAddress, isDevModeActive } from '@/lib/devMode';

/**
 * Persistent, unmissable warning shown whenever the dashboard's dev-mode
 * wallet fallback is armed (NEXT_PUBLIC_DEV_WALLET configured and permitted
 * by the current build). Rendered from the root layout so it covers the
 * login page and every dashboard page.
 */
export function DevModeBanner() {
  if (!isDevModeActive()) {
    return null;
  }

  const wallet = getDevWalletAddress();

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 w-full bg-amber-500 text-black text-center text-xs font-semibold py-1.5 px-4 flex items-center justify-center gap-2"
    >
      <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
      <span>DEV MODE — wallet authentication fallback is active</span>
      {wallet ? <span className="font-mono">({wallet})</span> : null}
      <span className="font-normal">
        Remove NEXT_PUBLIC_DEV_WALLET before deploying to production.
      </span>
    </div>
  );
}
