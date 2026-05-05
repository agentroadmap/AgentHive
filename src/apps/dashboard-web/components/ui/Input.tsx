import type React from "react";
import { cn } from "../../lib/cn";

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  inputSize?: "sm" | "md" | "lg";
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      hint,
      leftIcon,
      rightIcon,
      inputSize = "md",
      className,
      id,
      disabled,
      ...props
    },
    ref
  ) => {
    const inputId = id ?? `input-${Math.random().toString(36).slice(2, 9)}`;
    const errorId = error ? `${inputId}-error` : undefined;
    const hintId = hint ? `${inputId}-hint` : undefined;

    const sizeClasses: Record<NonNullable<InputProps["inputSize"]>, string> = {
      sm: "py-1.5 text-xs",
      md: "py-2 text-sm",
      lg: "py-2.5 text-base",
    };

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-[var(--color-text)]"
          >
            {label}
          </label>
        )}
        <div className="relative flex items-center">
          {leftIcon && (
            <span className="absolute left-3 flex items-center text-[var(--color-text-muted)] pointer-events-none">
              {leftIcon}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            disabled={disabled}
            aria-describedby={[errorId, hintId].filter(Boolean).join(" ") || undefined}
            aria-invalid={error ? true : undefined}
            className={cn(
              "w-full rounded-[var(--radius-md)] border bg-[var(--color-surface)]",
              "text-[var(--color-text)] placeholder:text-[var(--color-text-subtle)]",
              "transition-colors duration-[var(--transition-fast)]",
              "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)] focus-visible:outline-offset-0",
              error
                ? "border-[var(--color-error)] focus-visible:outline-[var(--color-error)]"
                : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]",
              disabled && "opacity-50 cursor-not-allowed",
              leftIcon ? "pl-10 pr-3" : "px-3",
              rightIcon ? "pr-10" : "",
              sizeClasses[inputSize],
              className
            )}
            {...props}
          />
          {rightIcon && (
            <span className="absolute right-3 flex items-center text-[var(--color-text-muted)] pointer-events-none">
              {rightIcon}
            </span>
          )}
        </div>
        {error && (
          <p id={errorId} role="alert" className="text-xs text-[var(--color-error)]">
            {error}
          </p>
        )}
        {hint && !error && (
          <p id={hintId} className="text-xs text-[var(--color-text-muted)]">
            {hint}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
