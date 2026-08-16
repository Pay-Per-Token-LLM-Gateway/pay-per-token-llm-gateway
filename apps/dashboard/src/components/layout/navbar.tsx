'use client';

import { Bell, Settings, Wallet, LogOut, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/useAuth';
import { useEffect, useState } from 'react';

const STELLAR_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'testnet';
const NETWORK_LABEL = STELLAR_NETWORK.charAt(0).toUpperCase() + STELLAR_NETWORK.slice(1);

export function Navbar() {
  const { address, isConnected, loading, disconnect } = useAuth();
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<
    Array<{
      id: string;
      event: string;
      data: Record<string, unknown>;
      read: boolean;
      timestamp: string;
    }>
  >([]);

  useEffect(() => {
    if (!isConnected || !address) return;

    const fetchUnread = async () => {
      try {
        const res = await fetch(`/api/gateway/notifications/unread-count`);
        if (res.ok) {
          const data = await res.json();
          setUnreadCount(data.unread);
        }
      } catch {
        // Silently fail — polling will retry
      }
    };

    fetchUnread();
    const interval = setInterval(fetchUnread, 30_000);
    return () => clearInterval(interval);
  }, [isConnected, address]);

  const toggleNotifications = async () => {
    if (notificationsOpen) {
      setNotificationsOpen(false);
      return;
    }
    try {
      const res = await fetch('/api/gateway/notifications?limit=10');
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
      }
    } catch {
      // Silently fail
    }
    setNotificationsOpen(true);
  };

  const markAsRead = async (id: string) => {
    try {
      await fetch(`/api/gateway/notifications/${id}/read`, { method: 'POST' });
      setUnreadCount((prev) => Math.max(0, prev - 1));
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    } catch {
      // Silently fail
    }
  };

  return (
    <header className="h-16 border-b border-border bg-card/50 backdrop-blur-sm flex items-center justify-between px-6 shrink-0">
      <div className="flex items-center gap-2">
        <img src="/icon.svg" alt="x402" className="w-8 h-8 rounded-lg" />
        <span className="font-semibold text-lg">x402 Gateway</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-green-900/30 text-green-400 border border-green-800/50 ml-2">
          {NETWORK_LABEL}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative">
          <button
            onClick={toggleNotifications}
            className="p-2 hover:bg-gray-800 rounded-lg transition-colors relative"
          >
            <Bell className="w-5 h-5 text-gray-400" />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-green-500 rounded-full text-white text-xs flex items-center justify-center font-medium">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          {notificationsOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setNotificationsOpen(false)} />
              <div className="absolute right-0 mt-2 w-80 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 max-h-96 overflow-y-auto">
                <div className="px-4 py-3 border-b border-gray-700">
                  <h3 className="text-sm font-semibold text-gray-200">Notifications</h3>
                </div>
                {notifications.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-gray-500">
                    No notifications yet
                  </div>
                ) : (
                  <div className="divide-y divide-gray-800">
                    {notifications.map((n) => (
                      <div
                        key={n.id}
                        className={`px-4 py-3 hover:bg-gray-800/50 transition-colors ${
                          !n.read ? 'bg-gray-800/30' : ''
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-gray-200 truncate">{n.event}</p>
                            <p className="text-xs text-gray-500 mt-0.5">
                              {new Date(n.timestamp).toLocaleString()}
                            </p>
                          </div>
                          {!n.read && (
                            <button
                              onClick={() => markAsRead(n.id)}
                              className="text-xs text-green-400 hover:text-green-300 shrink-0 mt-0.5"
                            >
                              Mark read
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <button className="p-2 hover:bg-gray-800 rounded-lg transition-colors">
          <Settings className="w-5 h-5 text-gray-400" />
        </button>

        {loading ? (
          <div className="flex items-center gap-2 px-3 py-2">
            <Loader2 className="w-4 h-4 text-green-400 animate-spin" />
            <span className="text-sm text-muted-foreground">Connecting...</span>
          </div>
        ) : isConnected && address ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground font-mono">
              {address.slice(0, 6)}...{address.slice(-4)}
            </span>
            <button
              onClick={disconnect}
              className="text-sm text-red-400 hover:text-red-300 flex items-center gap-1 transition-colors"
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
