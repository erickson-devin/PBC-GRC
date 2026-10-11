import React from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { errorMessage } from '../../utils/errors';

/**
 * - `root`:  full-screen fallback for the whole application
 * - `panel`: inline card that replaces a failed view in place (navigation stays usable)
 * - `modal`: centered overlay with a Close action for inspectors / drawers
 */
export type ErrorBoundaryVariant = 'root' | 'panel' | 'modal';

export interface ErrorBoundaryProps {
  /** Human-readable name of the guarded area, shown in the fallback and the console log. */
  name: string;
  variant?: ErrorBoundaryVariant;
  /** Called when the user dismisses the fallback (Retry / Close). Use it to clear the state that caused the crash. */
  onReset?: () => void;
  /** The boundary resets automatically whenever any of these values change (e.g. active framework / selected control). */
  resetKeys?: ReadonlyArray<unknown>;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const keysChanged = (a: ReadonlyArray<unknown> = [], b: ReadonlyArray<unknown> = []): boolean =>
  a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(errorMessage(error) || 'Unknown rendering error') };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.name}] Unhandled render exception`, error, info.componentStack);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && keysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null });
    }
  }

  private handleReset = (): void => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { name, variant = 'panel' } = this.props;
    const showStack = import.meta.env.DEV && Boolean(error.stack);

    const details = (
      <details className="mt-3 text-left group">
        <summary className="cursor-pointer text-[11px] font-medium text-slate-400 hover:text-slate-200 select-none">
          Technical details
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-slate-950 border border-slate-800 p-3 text-[11px] leading-relaxed text-rose-300 font-mono whitespace-pre-wrap break-words">
          {error.message || 'Unknown error'}
          {showStack ? `\n\n${error.stack}` : ''}
        </pre>
      </details>
    );

    const body = (
      <div role="alert" className="w-full max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-rose-500/30 bg-rose-500/10 text-rose-400">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <span className="inline-flex items-center rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[10px] font-bold uppercase leading-none tracking-wider text-rose-300">
          Render error
        </span>
        <h2 className="mt-3 text-base font-bold text-white">
          {variant === 'root' ? 'Something went wrong' : `${name} couldn’t be displayed`}
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
          {variant === 'root'
            ? 'The application hit an unexpected error. Your saved assessment data has not been modified.'
            : 'An unexpected error occurred while rendering this section. The rest of the application is unaffected and your saved data has not been modified.'}
        </p>
        <div className="mt-5 flex items-center justify-center gap-2.5">
          {variant === 'root' ? (
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-500 px-4 py-2 text-xs font-bold leading-none text-slate-950 transition-colors hover:bg-cyan-400"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload application
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={this.handleReset}
                className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-500 px-4 py-2 text-xs font-bold leading-none text-slate-950 transition-colors hover:bg-cyan-400"
              >
                {variant === 'modal' ? <X className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {variant === 'modal' ? 'Close' : 'Try again'}
              </button>
              {variant === 'modal' && (
                <button
                  type="button"
                  onClick={() => this.setState({ error: null })}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-semibold leading-none text-slate-200 transition-colors hover:border-slate-600 hover:text-white"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
                </button>
              )}
            </>
          )}
        </div>
        {details}
      </div>
    );

    if (variant === 'root') {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">{body}</div>
      );
    }

    if (variant === 'modal') {
      return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">{body}</div>
        </div>
      );
    }

    return (
      <div className="flex w-full justify-center rounded-2xl border border-slate-800 bg-slate-900/60 p-8">{body}</div>
    );
  }
}

export default ErrorBoundary;
