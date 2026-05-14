import type React from "react";
import { cn } from "../../lib/cn";

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  breadcrumbs?: { label: string; href?: string; onClick?: () => void }[];
  className?: string;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  actions,
  breadcrumbs,
  className,
}) => {
  return (
    <header
      className={cn(
        "flex flex-col gap-1 pb-4 border-b border-[var(--color-border)]",
        className
      )}
    >
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden="true">/</span>}
              {crumb.href || crumb.onClick ? (
                <a
                  href={crumb.href}
                  onClick={crumb.onClick}
                  className={cn(
                    "hover:text-[var(--color-text)] transition-colors duration-[var(--transition-fast)]",
                    "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)] focus-visible:outline-offset-1 rounded-sm"
                  )}
                >
                  {crumb.label}
                </a>
              ) : (
                <span aria-current={i === breadcrumbs.length - 1 ? "page" : undefined}>
                  {crumb.label}
                </span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)] truncate">
            {title}
          </h1>
          {description && (
            <p className="text-sm text-[var(--color-text-muted)]">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        )}
      </div>
    </header>
  );
};
