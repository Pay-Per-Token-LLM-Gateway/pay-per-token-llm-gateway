'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'x402-theme';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function getSystemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Resolve the effective theme: explicit user choice wins, else system preference. */
function resolveTheme(stored: Theme | null): Theme {
  return stored ?? getSystemTheme();
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/**
 * Dark/light theme context for the dashboard.
 *
 * - Preference is persisted in localStorage (`x402-theme`).
 * - On first visit (no stored preference) the OS `prefers-color-scheme` is
 *   respected; the theme keeps following OS changes until the user toggles
 *   manually (same semantics as most shadcn-based dashboards).
 * - An inline script in `layout.tsx` applies the class before first paint to
 *   avoid a flash of the wrong theme (FOUC).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Safe SSR default; the mount effect immediately syncs to the real preference.
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const stored = getStoredTheme();
    const effective = resolveTheme(stored);
    applyTheme(effective);
    setTheme(effective);

    // Follow OS theme changes only while the user has no explicit preference.
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      if (getStoredTheme() === null) {
        const next = getSystemTheme();
        applyTheme(next);
        setTheme(next);
      }
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // localStorage unavailable (private mode) — theme still applies for this session.
      }
      applyTheme(next);
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a <ThemeProvider>');
  }
  return ctx;
}
