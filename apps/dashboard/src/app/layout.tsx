import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers/providers';
import { Navbar } from '@/components/layout/navbar';
import { Sidebar } from '@/components/layout/sidebar';
import { ThemeProvider } from '@/components/providers/theme-provider';

export const metadata: Metadata = {
  title: 'x402 Gateway - Provider Dashboard',
  description:
    'Manage your LLM endpoints, track revenue, and configure pricing — all through x402 micropayments on Stellar.',
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 min-h-screen">
        <ThemeProvider defaultTheme="system" storageKey="x402-ui-theme">
          <Providers>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            <div className="flex-1 flex flex-col overflow-hidden">
              <Navbar />
              <main className="flex-1 overflow-y-auto p-6">{children}</main>
            </div>
          </div>
        </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
