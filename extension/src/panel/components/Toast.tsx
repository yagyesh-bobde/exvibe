/** Minimal toast system: <ToastProvider> + useToast(). No portal libs. */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

export type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  toast: (kind: ToastKind, message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const TONE: Record<ToastKind, { dot: string; border: string }> = {
  success: { dot: 'bg-[var(--accent)]', border: 'border-[rgba(62,207,142,0.35)]' },
  error: { dot: 'bg-[var(--red)]', border: 'border-[rgba(240,86,74,0.4)]' },
  info: { dot: 'bg-[var(--muted)]', border: 'border-[var(--line-strong)]' },
};

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col gap-1.5">
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            className={`ev-toast pointer-events-auto flex w-full items-center gap-2 rounded border ${TONE[t.kind].border} bg-[var(--panel-2)] px-3 py-2 text-left text-[11px] leading-snug text-[var(--text)] shadow-[0_8px_24px_rgba(0,0,0,0.45)]`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[t.kind].dot}`} />
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
