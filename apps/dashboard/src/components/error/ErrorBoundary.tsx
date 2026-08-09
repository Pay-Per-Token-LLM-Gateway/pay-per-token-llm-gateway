'use client';

import React from 'react';
import { ErrorState } from './ErrorState';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional — when the key changes the boundary resets, useful per-route. */
  resetKey?: string | number;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary that catches render errors in its children.
 * Pair with a changing `resetKey` (e.g. `location.pathname`) to
 * auto-recover on navigation.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    // Reset when the route changes (resetKey changes)
    if (this.props.resetKey !== prevProps.resetKey && this.state.hasError) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <ErrorState
          error={this.state.error}
          onRetry={this.handleRetry}
        />
      );
    }

    return this.props.children;
  }
}