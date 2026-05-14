import type React from "react";
import { cn } from "../../lib/cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  options: SelectOption[];
  size?: "sm" | "md" | "lg";
  label?: string;
  hint?: string;
  error?: string;
  placeholder?: string;
}

const sizeClasses: Record<NonNullable<SelectProps["size"]>, string> = {
  sm: "py-1.5 pl-3 pr-8 text-xs",
  md: "py-2 pl-3 pr-9 text-sm",
  lg: "py-2.5 pl-4 pr-10 text-base",
};

const iconSizeClasses: Record<NonNullable<SelectProps["size"]>, string> = {
  sm: "right-2 w-3.5 h-3.5",
  md: "right-2.5 w-4 h-4",
  lg: "right-3 w-4 h-4",
};

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      options,
      size = "md",
      label,
      hint,
      error,
      placeholder,
      className,
      id: idProp,
      disabled,
      ...props
    },
    ref
  ) => {
    const id = idProp ?? `select-${Math.random().toString(36).slice(2, 9)}`;
    const hintId = hint ? `${id}-hint` : undefined;
    const errorId = error ? `${id}-error` : undefined;
    const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label
            htmlFor={id}
            className="text-sm font-medium text-[var(--color-text)]"
          >
            {label}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            id={id}
            disabled={disabled}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            className={cn(
              "w-full appearance-none rounded-[var(--radius-md)] border",
              "bg-[var(--color-surface)] text-[var(--color-text)]",
              "transition-colors duration-[var(--transition-fast)]",
              "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)] focus-visible:outline-offset-0",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              error
                ? "border-[var(--color-error)] hover:border-[var(--color-error)]"
                : "border-[var(--color-border-strong)] hover:border-[var(--color-border-strong)]",
              sizeClasses[size],
              className
            )}
            {...props}
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </select>
          <span
            className={cn(
              "pointer-events-none absolute top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]",
              iconSizeClasses[size]
            )}
            aria-hidden="true"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
        {hint && !error && (
          <p id={hintId} className="text-xs text-[var(--color-text-muted)]">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} className="text-xs text-[var(--color-error)]" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
);

Select.displayName = "Select";
