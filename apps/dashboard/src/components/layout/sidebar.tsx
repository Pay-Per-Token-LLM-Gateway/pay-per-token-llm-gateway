'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard,
  Route,
  DollarSign,
  FileText,
  Settings,
  Webhook,
  Shield,
} from 'lucide-react';

const links = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/routes', label: 'Routes', icon: Route },
  { href: '/payments', label: 'Payments', icon: DollarSign },
  { href: '/audit', label: 'Audit Log', icon: FileText },
  { href: '/webhooks', label: 'Webhooks', icon: Webhook },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 border-r border-border bg-card/30 shrink-0 hidden lg:flex flex-col">
      <div className="p-6">
        <Link href="/" className="flex items-center gap-3 group">
          <img
            src="/icon.svg"
            alt="x402 Logo"
            className="w-10 h-10 rounded-xl shadow-lg shadow-green-500/20 transition-transform group-hover:scale-105"
          />
          <div>
            <h1 className="font-bold text-lg tracking-tight group-hover:text-green-600 dark:group-hover:text-green-400 transition-colors">
              x402
            </h1>
            <p className="text-xs text-muted-foreground">LLM Gateway</p>
          </div>
        </Link>
      </div>

      <nav className="flex-1 px-3 space-y-1">
        {links.map((link) => {
          const isActive = pathname === link.href;
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                isActive
                  ? 'bg-green-100/80 text-green-700 border border-green-300/60 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              <Icon className={`w-5 h-5 ${isActive ? 'text-green-700 dark:text-green-400' : ''}`} />
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-border">
        <div className="card bg-muted/40">
          <div className="flex items-center gap-2 mb-2">
            <Shield className="w-4 h-4 text-green-600 dark:text-green-400" />
            <span className="text-xs font-semibold text-green-600 dark:text-green-400">
              Secured by Stellar
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            All payments verified on-chain via Horizon & Soroban RPC
          </p>
        </div>
      </div>
    </aside>
  );
}
