'use client';

import { Bell, Settings, Wallet, LogOut, Loader2, Sun, Moon } from 'lucide-react';
import { useAuth } from '@/lib/useAuth';
import { useTheme } from '@/components/theme-provider';

const STELLAR_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'testnet';
const NETWORK_LABEL = STELLAR_NETWORK.charAt(0).toUpperCase() + STELLAR_NETWORK.slice(1);

export function Navbar() {
  const { address, isConnected, loading, disconnect } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="h-16 border-b border-border bg-card/50 backdrop-blur-sm flex items-center justify-between px-6 shrink-0">
      <div className="flex items-center gap-2">
        <img src="/icon.svg" alt="x402" className="w-8 h-8 rounded-lg" />
        <span className="font-semibold text-lg">x402 Gateway</span>
        <span className="badge badge-green ml-2">{NETWORK_LABEL}</span>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="p-2 hover:bg-muted rounded-lg transition-colors"
        >
          {theme === 'dark' ? (
            <Sun className="w-5 h-5 text-muted-foreground" />
          ) : (
            <Moon className="w-5 h-5 text-muted-foreground" />
          )}
        </button>

        <button className="p-2 hover:bg-muted rounded-lg transition-colors relative">
          <Bell className="w-5 h-5 text-muted-foreground" />
          <span className="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full" />
        </button>

        <button className="p-2 hover:bg-muted rounded-lg transition-colors">
          <Settings className="w-5 h-5 text-muted-foreground" />
        </button>

        {loading ? (
          <div className="flex items-center gap-2 px-3 py-2">
            <Loader2 className="w-4 h-4 text-green-500 animate-spin" />
            <span className="text-sm text-muted-foreground">Connecting...</span>
          </div>
        ) : isConnected && address ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground font-mono">
              {address.slice(0, 6)}...{address.slice(-4)}
            </span>
            <button
              onClick={disconnect}
              className="text-sm text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300 flex items-center gap-1 transition-colors"
            >
              <LogOut className="w-4 h-4" /> Disconnect
            </button>
          </div>
        ) : (
          <a
            href="/login"
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors text-sm font-medium"
          >
            <Wallet className="w-4 h-4" />
            Connect Wallet
          </a>
        )}
      </div>
    </header>
  );
}
