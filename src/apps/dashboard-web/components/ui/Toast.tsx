import type React from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

interface ToastContextType {
  toasts: ToastItem[];
  toast: (message: string, type?: ToastType, duration?: number) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

let toastIdCounter = 0;

const typeStyles: Record<ToastType, string> = {
  success: "bg-[var(--color-success-bg)] text-[var(--color-success-fg)] border-[var(--color-success)]",
  error:   "bg-[var(--color-error-bg)] text-[var(--color-error-fg)] border-[var(--color-error)]",
  warning: "bg-[var(--color-warning-bg)] text-[var(--color-warning-fg)] border-[var(--color-warning)]",
  info:    "bg-[var(--color-info-bg)] text-[var(--color-info-fg)] border-[var(--color-info)]",
};

const typeIcons: Record<ToastType, string> = {
  success: "✓",
  error: "✕",
  warning: "⚠",
  info: "ℹ",
};

interface SingleToastProps {
  item: ToastItem;
  onDismiss: (id: string) => void;
}

function SingleToast({ item, onDismiss }: SingleToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const dur = item.duration ?? 5000;
    timerRef.current = setTimeout(() => onDismiss(item.id), dur);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [item.id, item.duration, onDismiss]);

  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 px-4 py-3 rounded-[var(--radius-md)] border",
        "shadow-[var(--shadow-md)] min-w-64 max-w-sm",
        "animate-slide-in-right",
        typeStyles[item.type]
      )}
    >
      <span className="shrink-0 font-bold text-base leading-5" aria-hidden="true">
        {typeIcons[item.type]}
      </span>
      <p className="flex-1 text-sm font-medium">{item.message}</p>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
        className={cn(
          "shrink-0 w-5 h-5 flex items-center justify-center rounded",
          "opacity-70 hover:opacity-100 transition-opacity duration-[var(--transition-fast)]",
          "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)]"
        )}
      >
        ×
      </button>
    </div>
  );
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = "info", duration?: number) => {
      const id = `toast-${++toastIdCounter}`;
      setToasts((prev) => [...prev, { id, type, message, duration }]);
    },
    []
  );

  return (
    <ToastContext.Provider value={{ toasts, toast, dismiss }}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed top-4 right-4 z-[100] flex flex-col gap-2"
      >
        {toasts.map((item) => (
          <SingleToast key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
};
