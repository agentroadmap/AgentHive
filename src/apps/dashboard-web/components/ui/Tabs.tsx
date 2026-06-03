import type React from "react";
import { useCallback, useRef, useState } from "react";
import { cn } from "../../lib/cn";

export interface TabItem {
  key: string;
  label: React.ReactNode;
  content: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  defaultTab?: string;
  value?: string;
  onChange?: (key: string) => void;
  className?: string;
  tabListClassName?: string;
  panelClassName?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  items,
  defaultTab,
  value,
  onChange,
  className,
  tabListClassName,
  panelClassName,
}) => {
  const [internalActive, setInternalActive] = useState(
    defaultTab ?? items[0]?.key ?? ""
  );
  const active = value ?? internalActive;
  const tabListRef = useRef<HTMLDivElement | null>(null);

  const activate = useCallback(
    (key: string) => {
      setInternalActive(key);
      onChange?.(key);
    },
    [onChange]
  );

  // Arrow key navigation per WAI-ARIA tabs pattern
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, currentKey: string) => {
      const enabled = items.filter((i) => !i.disabled);
      const idx = enabled.findIndex((i) => i.key === currentKey);
      if (idx === -1) return;

      let next = idx;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        next = (idx + 1) % enabled.length;
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        next = (idx - 1 + enabled.length) % enabled.length;
      } else if (e.key === "Home") {
        e.preventDefault();
        next = 0;
      } else if (e.key === "End") {
        e.preventDefault();
        next = enabled.length - 1;
      } else {
        return;
      }

      const nextKey = enabled[next].key;
      activate(nextKey);
      // Move DOM focus to the activated tab button
      const btn = tabListRef.current?.querySelector<HTMLButtonElement>(
        `[data-tab-key="${nextKey}"]`
      );
      btn?.focus();
    },
    [items, activate]
  );

  const activeItem = items.find((i) => i.key === active);

  return (
    <div className={cn("flex flex-col", className)}>
      <div
        ref={tabListRef}
        role="tablist"
        aria-orientation="horizontal"
        className={cn(
          "flex border-b border-[var(--color-border)]",
          tabListClassName
        )}
      >
        {items.map((item) => {
          const isActive = item.key === active;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              data-tab-key={item.key}
              aria-selected={isActive}
              aria-controls={`tabpanel-${item.key}`}
              id={`tab-${item.key}`}
              tabIndex={isActive ? 0 : -1}
              disabled={item.disabled}
              onClick={() => !item.disabled && activate(item.key)}
              onKeyDown={(e) => handleKeyDown(e, item.key)}
              className={cn(
                "px-4 py-2.5 text-sm font-medium -mb-px border-b-2",
                "transition-colors duration-[var(--transition-fast)]",
                "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)] focus-visible:outline-offset-2",
                isActive
                  ? "border-[var(--color-primary)] text-[var(--color-primary)]"
                  : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]",
                item.disabled && "opacity-40 cursor-not-allowed"
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {activeItem && (
        <div
          role="tabpanel"
          id={`tabpanel-${activeItem.key}`}
          aria-labelledby={`tab-${activeItem.key}`}
          className={cn("py-4", panelClassName)}
        >
          {activeItem.content}
        </div>
      )}
    </div>
  );
};
