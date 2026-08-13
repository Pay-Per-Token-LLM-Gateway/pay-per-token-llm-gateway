import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers/providers';
import { ThemeProvider } from '@/components/theme-provider';
import { Navbar } from '@/components/layout/navbar';
import { Sidebar } from '@/components/layout/sidebar';

export const metadata: Metadata = {
  title: 'x402 Gateway - Provider Dashboard',
  description:
    'Manage your LLM endpoints, track revenue, and configure pricing — all through x402 micropayments on Stellar.',
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
};

/**
 * Applies the persisted/system theme to <html> before first paint so the
 * dashboard never flashes the wrong theme (FOUC). Mirrors the logic in
 * components/theme-provider.tsx: explicit localStorage choice wins, otherwise
 * the OS `prefers-color-scheme` is respected (dark fallback).
 */
const themeInitScript = `(function () {
  try {
    var stored = localStorage.getItem('x402-theme');
    var dark = stored
      ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: light)').matches === false;
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-background text-foreground min-h-screen">
        <Providers>
          <ThemeProvider>
            <div className="flex h-screen overflow-hidden">
              <Sidebar />
              <div className="flex-1 flex flex-col overflow-hidden">
                <Navbar />
                <main className="flex-1 overflow-y-auto p-6">{children}</main>
              </div>
            </div>
          </ThemeProvider>
        </Providers>
      </body>
    </html>
  );
}
