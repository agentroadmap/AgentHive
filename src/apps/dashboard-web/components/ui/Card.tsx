import type React from "react";
import { cn } from "../../lib/cn";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  elevation?: "sm" | "md" | "lg";
  padding?: "none" | "sm" | "md" | "lg";
}

export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}
export interface CardBodyProps extends React.HTMLAttributes<HTMLDivElement> {}
export interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

const elevationClasses: Record<NonNullable<CardProps["elevation"]>, string> = {
  sm: "shadow-[var(--shadow-sm)]",
  md: "shadow-[var(--shadow-md)]",
  lg: "shadow-[var(--shadow-lg)]",
};

const paddingClasses: Record<NonNullable<CardProps["padding"]>, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export const Card: React.FC<CardProps> = ({
  elevation = "sm",
  padding = "md",
  children,
  className,
  ...props
}) => {
  return (
    <div
      className={cn(
        "bg-[var(--color-surface)] border border-[var(--color-border)]",
        "rounded-[var(--radius-lg)]",
        "transition-colors duration-[var(--transition-normal)]",
        elevationClasses[elevation],
        paddingClasses[padding],
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

export const CardHeader: React.FC<CardHeaderProps> = ({
  children,
  className,
  ...props
}) => (
  <div
    className={cn(
      "pb-3 mb-3 border-b border-[var(--color-border)]",
      "font-semibold text-[var(--color-text)]",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export const CardBody: React.FC<CardBodyProps> = ({
  children,
  className,
  ...props
}) => (
  <div className={cn("text-[var(--color-text)]", className)} {...props}>
    {children}
  </div>
);

export const CardFooter: React.FC<CardFooterProps> = ({
  children,
  className,
  ...props
}) => (
  <div
    className={cn(
      "pt-3 mt-3 border-t border-[var(--color-border)]",
      "text-[var(--color-text-muted)]",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
