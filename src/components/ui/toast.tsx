'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';
import { cn } from '@/lib/cn';

type Toast = { id: number; tone: 'success' | 'danger'; message: string };

const ToastContext = createContext<{
  success: (message: string) => void;
  error: (message: string) => void;
} | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const value = useMemo(
    () => ({
      success: (message: string) => push('success', message),
      error: (message: string) => push('danger', message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* aria-live so a screen reader announces the outcome of an action that
          produced no visible navigation. */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 start-4 z-50 flex flex-col gap-2"
      >
        {toasts.map((toast) => {
          const Icon = toast.tone === 'success' ? CheckCircle2 : XCircle;
          return (
            <div
              key={toast.id}
              role={toast.tone === 'danger' ? 'alert' : 'status'}
              className={cn(
                'pointer-events-auto flex items-start gap-2 rounded border px-4 py-3 text-sm shadow-pop animate-fade-in',
                toast.tone === 'success'
                  ? 'border-success/20 bg-success/10 text-success'
                  : 'border-danger/20 bg-danger/10 text-danger',
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="max-w-xs">{toast.message}</span>
              <button
                type="button"
                onClick={() => setToasts((t) => t.filter((x) => x.id !== toast.id))}
                aria-label="إغلاق"
                className="opacity-60 hover:opacity-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
