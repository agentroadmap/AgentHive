import type React from "react";
import { useRef, useState } from "react";
import { cn } from "../../lib/cn";

export interface TabItem {
  key: string;
  label: React.ReactNode;
  content: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  defaultTab?: string;
  activeTab?: string;
  onChange?: (key: string) => void;
  className?: string;
  tabListClassName?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  defaultTab,
  activeTab: controlledTab,
  onChange,
  className,
  tabListClassName,
}) => {
  const [internalActive, setInternalActive] = useState(
    defaultTab ?? tabs.find((t) => !t.disabled)?.key ?? ""
  );
  const tabListRef = useRef<HTMLDivElement>(null);
  const panelId = useRef(`tabs-panel-${Math.random().toString(36).slice(2, 9)}`).current;

  const active = controlledTab ?? internalActive;
  const setActive = (key: string) => {
    setInternalActive(key);
    onChange?.(key);
  };

  const handleKeyDown = (e: React.KeyboardEvent, currentIdx: number) => {
    const enabledTabs = tabs.filter((t) => !t.disabled);
    const enabledIdx = enabledTabs.findIndex((t) => tabs[currentIdx].key === t.key);

    if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = enabledTabs[(enabledIdx + 1) % enabledTabs.length];
      if (next) {
        setActive(next.key);
        tabListRef.current
          ?.querySelector<HTMLButtonElement>(`[data-tabkey="${next.key}"]`)
          ?.focus();
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = enabledTabs[(enabledIdx - 1 + enabledTabs.length) % enabledTabs.length];
      if (prev) {
        setActive(prev.key);
        tabListRef.current
          ?.querySelector<HTMLButtonElement>(`[data-tabkey="${prev.key}"]`)
          ?.focus();
      }
    } else if (e.key === "Home") {
      e.preventDefault();
      const first = enabledTabs[0];
      if (first) {
        setActive(first.key);
        tabListRef.current
          ?.querySelector<HTMLButtonElement>(`[data-tabkey="${first.key}"]`)
          ?.focus();
      }
    } else if (e.key === "End") {
      e.preventDefault();
      const last = enabledTabs[enabledTabs.length - 1];
      if (last) {
        setActive(last.key);
        tabListRef.current
          ?.querySelector<HTMLButtonElement>(`[data-tabkey="${last.key}"]`)
          ?.focus();
      }
    }
  };

  const activePanel = tabs.find((t) => t.key === active);

  return (
    <div className={cn("flex flex-col", className)}>
      <div
        ref={tabListRef}
        role="tablist"
        className={cn(
          "flex border-b border-[var(--color-border)] gap-0",
          tabListClassName
        )}
      >
        {tabs.map((tab, idx) => {
          const isActive = tab.key === active;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              data-tabkey={tab.key}
              aria-selected={isActive}
              aria-controls={`${panelId}-${tab.key}`}
              id={`${panelId}-tab-${tab.key}`}
              disabled={tab.disabled}
              tabIndex={isActive ? 0 : -1}
              onClick={() => !tab.disabled && setActive(tab.key)}
              onKeyDown={(e) => handleKeyDown(e, idx)}
              className={cn(
                "px-4 py-2 text-sm font-medium border-b-2 -mb-px",
                "transition-colors duration-[var(--transition-fast)]",
                "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)] focus-visible:outline-offset-2",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                isActive
                  ? "border-[var(--color-primary)] text-[var(--color-primary)]"
                  : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]"
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {activePanel && (
        <div
          id={`${panelId}-${activePanel.key}`}
          role="tabpanel"
          aria-labelledby={`${panelId}-tab-${activePanel.key}`}
          tabIndex={0}
          className="flex-1 focus:outline-none"
        >
          {activePanel.content}
        </div>
      )}
    </div>
  );
};
