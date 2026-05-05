import type React from "react";
import { cn } from "../../lib/cn";

export type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";
export type BadgeDisplay = "default" | "count" | "dot";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  display?: BadgeDisplay;
  count?: number;
  label?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  success:
    "bg-[var(--color-success-bg)] text-[var(--color-success-fg)]",
  warning:
    "bg-[var(--color-warning-bg)] text-[var(--color-warning-fg)]",
  error:
    "bg-[var(--color-error-bg)] text-[var(--color-error-fg)]",
  info:
    "bg-[var(--color-info-bg)] text-[var(--color-info-fg)]",
  neutral:
    "bg-[var(--color-neutral-bg)] text-[var(--color-neutral-fg)]",
};

const dotColorClasses: Record<BadgeVariant, string> = {
  success: "bg-[var(--color-success)]",
  warning: "bg-[var(--color-warning)]",
  error: "bg-[var(--color-error)]",
  info: "bg-[var(--color-info)]",
  neutral: "bg-[var(--color-neutral)]",
};

export const Badge: React.FC<BadgeProps> = ({
  variant = "neutral",
  display = "default",
  count,
  label,
  children,
  className,
  ...props
}) => {
  if (display === "dot") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-xs font-medium",
          variantClasses[variant],
          "px-2 py-0.5 rounded-[var(--radius-sm)]",
          className
        )}
        {...props}
      >
        <span
          className={cn("w-2 h-2 rounded-full shrink-0", dotColorClasses[variant])}
          aria-hidden="true"
        />
        {label ?? children}
      </span>
    );
  }

  if (display === "count") {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5",
          "text-[10px] font-semibold rounded-full",
          variantClasses[variant],
          className
        )}
        {...props}
      >
        {count ?? children}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-[var(--radius-sm)]",
        "text-xs font-medium",
        variantClasses[variant],
        className
      )}
      {...props}
    >
      {label ?? children}
    </span>
  );
};
