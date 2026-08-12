import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { Providers } from '@/components/providers/providers';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var e=localStorage.getItem('x402-theme');if(e==='light'||e==='dark'){document.documentElement.classList.toggle('dark',e==='dark')}else{document.documentElement.classList.toggle('dark',window.matchMedia('(prefers-color-scheme:dark)').matches)}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="bg-background text-foreground min-h-screen antialiased">
        <ThemeProvider>
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