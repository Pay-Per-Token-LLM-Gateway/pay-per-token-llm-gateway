import Link from 'next/link';
import { Home } from 'lucide-react';

export default function NotFoundPage() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="flex flex-col items-center gap-5 text-center">
        <img
          src="/icon.svg"
          alt="x402 Logo"
          className="w-20 h-20 rounded-2xl shadow-xl shadow-green-500/20 opacity-80"
        />
        <div>
          <h1 className="text-6xl font-bold text-gray-700 dark:text-gray-300">404</h1>
          <p className="text-muted-foreground mt-2 text-lg">Page not found</p>
          <p className="text-sm text-muted-foreground mt-1">
            The page you&apos;re looking for doesn&apos;t exist or has been moved.
          </p>
        </div>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Home className="w-4 h-4" />
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
