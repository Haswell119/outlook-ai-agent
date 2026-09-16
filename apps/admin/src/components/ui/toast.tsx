"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastTone = "success" | "error" | "info";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** `ApiError.correlationId` — shown so an operator can quote it to IT. */
  correlationId?: string;
  /** Adds a "Retry" button running this callback. */
  onRetry?: () => void;
  /** ms before auto-dismiss; `0` keeps it until dismissed. */
  duration?: number;
}

interface ToastRecord extends ToastInput {
  id: number;
}

interface ToastApi {
  toast: (input: ToastInput) => void;
  dismiss: (id: number) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

/**
 * Minimal, dependency-free toaster. Announced with `role="status"` /
 * `aria-live="polite"`, dismissible from the keyboard, and animation-free when
 * the operator asked for reduced motion (`motion-safe:` utilities).
 */
export function ToastProvider({
  children,
  labels,
}: {
  children: React.ReactNode;
  labels: { retry: string; dismiss: string; correlationId: string };
}) {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);
  const counter = React.useRef(0);

  const dismiss = React.useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback(
    (input: ToastInput) => {
      counter.current += 1;
      const id = counter.current;
      setToasts((list) => [...list, { ...input, id }].slice(-4));
      const duration = input.duration ?? (input.tone === "error" ? 12_000 : 5_000);
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const api = React.useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              "pointer-events-auto rounded-lg border bg-white p-3 shadow-lg motion-safe:animate-in motion-safe:slide-in-from-bottom-2",
              t.tone === "error"
                ? "border-[#C4314B]/40"
                : t.tone === "success"
                  ? "border-[#107C10]/40"
                  : "border-[#E1DFDD]",
            )}
          >
            <div className="flex items-start gap-2">
              {t.tone === "error" ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#C4314B]" />
              ) : t.tone === "success" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#107C10]" />
              ) : (
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[#242424]">{t.title}</p>
                {t.description && (
                  <p className="mt-0.5 break-words text-xs text-[#616161]">{t.description}</p>
                )}
                {t.correlationId && (
                  <p className="mt-1 break-all font-mono text-[10px] text-[#616161]">
                    {labels.correlationId}: {t.correlationId}
                  </p>
                )}
                {t.onRetry && (
                  <button
                    type="button"
                    onClick={() => {
                      dismiss(t.id);
                      t.onRetry?.();
                    }}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-[#E1DFDD] px-2 py-1 text-xs font-medium text-[#242424] hover:bg-[#F3F2F1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> {labels.retry}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label={labels.dismiss}
                className="rounded p-0.5 text-[#616161] hover:bg-[#F3F2F1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** No-op outside a provider so a component can be rendered in isolation. */
export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext);
  return ctx ?? { toast: () => undefined, dismiss: () => undefined };
}

/** Shape of the JSON error body returned by every route handler. */
export interface ApiErrorBody {
  error?: { code?: string; message?: string; correlationId?: string };
}

/** Turns a failed `fetch` response into a toast-ready payload. */
export async function readApiError(res: Response): Promise<{
  message: string;
  code?: string;
  correlationId?: string;
}> {
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  return {
    message: body?.error?.message ?? `Request failed (${res.status})`,
    code: body?.error?.code,
    correlationId: body?.error?.correlationId ?? res.headers.get("x-correlation-id") ?? undefined,
  };
}
