import type React from "react";
import { cn } from "../../lib/cn";

export interface SidebarProps {
  children: React.ReactNode;
  collapsed?: boolean;
  collapsedWidth?: string;
  expandedWidth?: string;
  className?: string;
  "aria-label"?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  children,
  collapsed = false,
  collapsedWidth = "w-16",
  expandedWidth = "w-64",
  className,
  "aria-label": ariaLabel = "Sidebar navigation",
}) => {
  return (
    <aside
      aria-label={ariaLabel}
      className={cn(
        "flex flex-col h-full shrink-0 overflow-y-auto overflow-x-hidden",
        "bg-[var(--color-surface-elevated)] border-r border-[var(--color-border)]",
        "transition-[width] duration-[var(--transition-normal)]",
        collapsed ? collapsedWidth : expandedWidth,
        className
      )}
    >
      {children}
    </aside>
  );
};

export interface SidebarItemProps {
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
  collapsed?: boolean;
  onClick?: () => void;
  href?: string;
  className?: string;
}

export const SidebarItem: React.FC<SidebarItemProps> = ({
  label,
  icon,
  active,
  collapsed,
  onClick,
  className,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center gap-3 w-full px-3 py-2 text-sm rounded-[var(--radius-md)] mx-1",
        "transition-colors duration-[var(--transition-fast)]",
        "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)] focus-visible:outline-offset-2",
        active
          ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
          : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]",
        collapsed && "justify-center px-2",
        className
      )}
    >
      {icon && <span className="shrink-0 w-5 h-5 flex items-center justify-center">{icon}</span>}
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  );
};

export interface SidebarSectionProps {
  title?: string;
  collapsed?: boolean;
  children: React.ReactNode;
  className?: string;
}

export const SidebarSection: React.FC<SidebarSectionProps> = ({
  title,
  collapsed,
  children,
  className,
}) => {
  return (
    <div className={cn("flex flex-col gap-1 py-2", className)}>
      {title && !collapsed && (
        <p className="px-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-subtle)] mb-1">
          {title}
        </p>
      )}
      {children}
    </div>
  );
};
