```tsx
import React, { useEffect, useState, createContext, useContext } from 'react';

// --- Types ---
type Theme = 'light' | 'dark' | 'system';

// --- Context ---
const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
}>({ theme: 'system', setTheme: () => {} });

// --- Hook ---
/**
 * useDarkMode: A hook to easily consume the theme state
 * and handle the logic of syncing state with localStorage.
 */
export const useDarkMode = () => {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    // 1. Check localStorage immediately on load
    const savedTheme = localStorage.getItem('theme') as Theme;
    
    // 2. If it exists, use it. 
    // 3. If not, it defaults to 'system' (which the CSS class strategy handles)
    if (savedTheme && ['light', 'dark', 'system'].includes(savedTheme)) {
      setTheme(savedTheme);
    }
  }, []);

  const toggleTheme = (val: Theme) => {
    setTheme(val);
    localStorage.setItem('theme', val);
  };

  return { theme, toggleTheme };
};

// --- Toggle Button Component ---
/**
 * DarkModeToggle: A button to switch between Light, Dark, and System.
 */
export const DarkModeToggle: React.FC = () => {
  const { theme, toggleTheme } = useDarkMode();

  // Determine the icon to show based on the logical theme
  const getIcon = () => {
    switch (theme) {
      case 'dark': return <SunIcon className="text-amber-400 w-5 h-5" />;
      case 'light': return <MoonIcon className="text-blue-300 w-5 h-5" />;
      default: return <MoonIcon className="text-gray-400 w-5 h-5" />;
    }
  };

  return (
    <button
      onClick={() => toggleTheme(theme === 'dark' ? 'light' : 'dark')}
      className="relative p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors"
      aria-label="Toggle Dark Mode"
      type="button"
    >
      {getIcon()}
    </button>
  );
};

// --- Icons ---
const MoonIcon = ({ className }: { className?: string }) => (
  <svg 
    xmlns="http://www.w3.org/2000/svg" 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    className={className}
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
  </svg>
);

const SunIcon = ({ className }: { className?: string }) => (
  <svg 
    xmlns="http://www.w3.org/2000/svg" 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    className={className}
  >
    <circle cx="12" cy="12" r="5"></circle>
    <line x1="12" y1="1" x2="12" y2="3"></line>
    <line x1="12" y1="21" x2="12" y2="23"></line>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
    <line x1="1" y1="12" x2="3" y2="12"></line>
    <line x1="21" y1="12" x2="23" y2="12"></line>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
  </svg>
);

// --- Provider Wrapper (Optional if used directly) ---
export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setTheme] = useState<Theme>('system');
  
  useEffect(() => {
    const root = document.documentElement; // targets <html> by default, or <body>
    const currentClass = root.getAttribute('class')?.includes('dark') || '';
    
    setTheme('system'); // Reset to system so the system check works
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      <div className="dark bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100 transition-colors duration-300">
        {children}
      </div>
    </ThemeContext.Provider>
  );
};

// --- Exporting a default wrapper component for easy insertion ---
export const DashboardLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="min-h-screen font-sans">
      {children}
    </div>
  );
};
```