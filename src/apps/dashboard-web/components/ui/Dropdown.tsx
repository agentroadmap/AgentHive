import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export interface DropdownItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  separator?: never;
}

export interface DropdownSeparator {
  separator: true;
  key: string;
  label?: never;
  icon?: never;
  disabled?: never;
  danger?: never;
}

export type DropdownOption = DropdownItem | DropdownSeparator;

export interface DropdownProps {
  trigger: React.ReactElement;
  items: DropdownOption[];
  onSelect: (key: string) => void;
  placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
  className?: string;
  menuClassName?: string;
}

const placementClasses: Record<NonNullable<DropdownProps["placement"]>, string> = {
  "bottom-start": "top-full left-0 mt-1",
  "bottom-end": "top-full right-0 mt-1",
  "top-start": "bottom-full left-0 mb-1",
  "top-end": "bottom-full right-0 mb-1",
};

export const Dropdown: React.FC<DropdownProps> = ({
  trigger,
  items,
  onSelect,
  placement = "bottom-start",
  className,
  menuClassName,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, close]);

  // Arrow key navigation
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const items = Array.from(
      menuRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])")
    );
    if (items.length > 0) items[0].focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      const focused = document.activeElement as HTMLButtonElement;
      const idx = items.indexOf(focused);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        items[(idx + 1) % items.length]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        items[(idx - 1 + items.length) % items.length]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        items[items.length - 1]?.focus();
      }
    };
    menuRef.current.addEventListener("keydown", handleKeyDown);
    return () => menuRef.current?.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const triggerEl = React.cloneElement(trigger, {
    "aria-haspopup": "menu",
    "aria-expanded": open,
    onClick: (e: React.MouseEvent) => {
      setOpen((prev) => !prev);
      trigger.props.onClick?.(e);
    },
  });

  return (
    <div ref={containerRef} className={cn("relative inline-block", className)}>
      {triggerEl}
      {open && (
        <ul
          ref={menuRef}
          role="menu"
          className={cn(
            "absolute z-50 min-w-[10rem] py-1",
            "bg-[var(--color-surface)] border border-[var(--color-border)]",
            "rounded-[var(--radius-md)] shadow-[var(--shadow-md)]",
            "focus:outline-none",
            placementClasses[placement],
            menuClassName
          )}
        >
          {items.map((item) => {
            if ("separator" in item && item.separator) {
              return (
                <li
                  key={item.key}
                  role="separator"
                  className="my-1 border-t border-[var(--color-border)]"
                />
              );
            }
            const { key, label, icon, disabled, danger } = item as DropdownItem;
            return (
              <li key={key} role="none">
                <button
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  onClick={() => {
                    onSelect(key);
                    close();
                  }}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2",
                    "text-sm text-left",
                    "transition-colors duration-[var(--transition-fast)]",
                    "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)]",
                    danger
                      ? "text-[var(--color-danger)] hover:bg-[var(--color-error-bg)]"
                      : "text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]",
                    disabled && "opacity-40 cursor-not-allowed pointer-events-none"
                  )}
                >
                  {icon && (
                    <span className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true">
                      {icon}
                    </span>
                  )}
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
