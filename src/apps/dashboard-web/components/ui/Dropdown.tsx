import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export interface DropdownItem {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  dividerAfter?: boolean;
}

export interface DropdownProps {
  trigger: React.ReactElement;
  items: DropdownItem[];
  align?: "left" | "right";
  className?: string;
}

export const Dropdown: React.FC<DropdownProps> = ({
  trigger,
  items,
  align = "left",
  className,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const menuId = useRef(`dropdown-${Math.random().toString(36).slice(2, 9)}`).current;

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) close();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, close]);

  // Arrow key navigation within menu
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const items = Array.from(
      menuRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])")
    );
    if (items.length > 0) items[0].focus();

    const handleKey = (e: KeyboardEvent) => {
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
    menuRef.current?.addEventListener("keydown", handleKey);
    return () => menuRef.current?.removeEventListener("keydown", handleKey);
  }, [open]);

  const triggerEl = React.cloneElement(trigger, {
    onClick: () => setOpen((v) => !v),
    "aria-haspopup": "true",
    "aria-expanded": open,
    "aria-controls": menuId,
  });

  return (
    <div ref={containerRef} className="relative inline-flex">
      {triggerEl}
      {open && (
        <ul
          ref={menuRef}
          id={menuId}
          role="menu"
          className={cn(
            "absolute z-50 mt-1 min-w-[10rem] rounded-[var(--radius-md)]",
            "bg-[var(--color-surface)] border border-[var(--color-border)]",
            "shadow-[var(--shadow-lg)] py-1 focus:outline-none",
            align === "right" ? "right-0" : "left-0",
            "top-full",
            className
          )}
        >
          {items.map((item, i) => (
            <li key={i} role="none" className={item.dividerAfter ? "border-b border-[var(--color-border)] pb-1 mb-1" : undefined}>
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  item.onClick();
                  close();
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left",
                  "transition-colors duration-[var(--transition-fast)]",
                  "focus:outline-none focus:bg-[var(--color-surface-hover)]",
                  "hover:bg-[var(--color-surface-hover)]",
                  item.danger
                    ? "text-[var(--color-danger)]"
                    : "text-[var(--color-text)]",
                  item.disabled && "opacity-50 cursor-not-allowed"
                )}
              >
                {item.icon && <span className="shrink-0 w-4 h-4">{item.icon}</span>}
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
