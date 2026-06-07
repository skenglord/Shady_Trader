import React, { Component, StrictMode } from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Global error handler - prevent default browser error dialog
window.onerror = (message, source, lineno, colno, error) => {
  console.error('Global error:', { message, source, lineno, colno, error });
  return true;
};

// Handle unhandled promise rejections
window.onunhandledrejection = (event) => {
  console.error('Unhandled rejection:', event.reason);
  event.preventDefault();
};

// Error boundary - shows error UI instead of reloading.
// Note: using `react-error-boundary` would be cleaner, but to keep the
// dependency surface minimal we implement it as a class component using
// the named import `Component` from react (avoids TS issues that occur
// when extending `React.Component` through the namespace default in
// some bundler-resolved setups).
interface ErrorBoundaryProps { children: React.ReactNode }
interface ErrorBoundaryState { hasError: boolean; error: Error | null }
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, _info: React.ErrorInfo) {
    console.error('Error boundary caught:', error.message);
  }
  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, color: '#f55', background: '#111', minHeight: '100vh' }}>
          <h1>Error</h1>
          <p>{this.state.error?.message}</p>
          <button onClick={(): void => { this.setState({ hasError: false }); }}>Continue</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
