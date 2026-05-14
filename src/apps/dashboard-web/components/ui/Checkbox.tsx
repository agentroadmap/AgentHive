import type React from "react";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/cn";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  description?: string;
  indeterminate?: boolean;
  error?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, description, indeterminate, error, className, id, ...props }, ref) => {
    const internalRef = useRef<HTMLInputElement | null>(null);
    const checkboxId = id ?? `checkbox-${Math.random().toString(36).slice(2, 7)}`;
    const descId = description ? `${checkboxId}-desc` : undefined;
    const errorId = error ? `${checkboxId}-error` : undefined;

    // Merge forwarded ref
    const setRef = (el: HTMLInputElement | null) => {
      internalRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
    };

    useEffect(() => {
      if (internalRef.current) {
        internalRef.current.indeterminate = indeterminate ?? false;
      }
    }, [indeterminate]);

    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={checkboxId} className="flex items-start gap-2 cursor-pointer select-none">
          <input
            ref={setRef}
            type="checkbox"
            id={checkboxId}
            aria-invalid={!!error}
            aria-describedby={[descId, errorId].filter(Boolean).join(" ") || undefined}
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0 rounded-[var(--radius-sm)]",
              "border border-[var(--color-border-strong)]",
              "accent-[var(--color-primary)]",
              "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)] focus-visible:outline-offset-2",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              error && "border-[var(--color-error)]",
              className
            )}
            {...props}
          />
          {(label || description) && (
            <span className="flex flex-col gap-0.5">
              {label && (
                <span className="text-sm font-medium text-[var(--color-text)]">{label}</span>
              )}
              {description && (
                <span id={descId} className="text-xs text-[var(--color-text-muted)]">
                  {description}
                </span>
              )}
            </span>
          )}
        </label>
        {error && (
          <p id={errorId} className="text-xs text-[var(--color-error)] ml-6" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
);

Checkbox.displayName = "Checkbox";
