import type React from "react";
import { cn } from "../../lib/cn";

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: "sm" | "md" | "lg";
}

const sizeClasses: Record<NonNullable<SpinnerProps["size"]>, string> = {
  sm: "w-4 h-4 border-2",
  md: "w-6 h-6 border-2",
  lg: "w-8 h-8 border-[3px]",
};

export const Spinner: React.FC<SpinnerProps> = ({
  size = "md",
  className,
  "aria-label": ariaLabel = "Loading",
  ...props
}) => {
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cn("inline-block shrink-0", className)}
      {...props}
    >
      <span
        className={cn(
          "block rounded-full border-current border-t-transparent animate-spin",
          sizeClasses[size]
        )}
      />
      <span className="sr-only">{ariaLabel}</span>
    </span>
  );
};
