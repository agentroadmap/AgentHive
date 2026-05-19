import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useFocusTrap } from "../../lib/a11y";
import { Spinner } from "../ui/Spinner";

export interface CommandPaletteItem {
  id: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  category?: string;
  keywords?: string[];
  onSelect: () => void;
  disabled?: boolean;
}

export interface CommandPaletteProps {
  items: CommandPaletteItem[];
  isOpen: boolean;
  onClose: () => void;
  placeholder?: string;
  loading?: boolean;
  onQueryChange?: (query: string) => void;
  className?: string;
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-[var(--color-warning-bg)] text-[var(--color-warning-fg)] rounded-sm">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  items,
  isOpen,
  onClose,
  placeholder = "Search commands…",
  loading = false,
  onQueryChange,
  className,
}) => {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useFocusTrap(isOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = "command-palette-listbox";

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setActiveIdx(0);
    } else {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.description?.toLowerCase().includes(q) ||
        item.keywords?.some((k) => k.toLowerCase().includes(q))
    );
  }, [items, query]);

  // Group by category
  const grouped = useMemo(() => {
    const map = new Map<string, CommandPaletteItem[]>();
    for (const item of filtered) {
      const cat = item.category ?? "";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(item);
    }
    return map;
  }, [filtered]);

  const flatFiltered = useMemo(() => filtered, [filtered]);

  const handleSelect = useCallback(
    (item: CommandPaletteItem) => {
      if (item.disabled) return;
      item.onSelect();
      onClose();
    },
    [onClose]
  );

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    const activeEl = listRef.current?.querySelector(`[data-active="true"]`);
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, flatFiltered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flatFiltered[activeIdx];
      if (item) handleSelect(item);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="absolute inset-0 bg-[var(--color-surface-overlay)]"
        aria-hidden="true"
      />
      <div
        ref={containerRef as React.RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={cn(
          "relative w-full max-w-xl rounded-[var(--radius-xl)]",
          "bg-[var(--color-surface)] shadow-[var(--shadow-lg)]",
          "border border-[var(--color-border)]",
          "overflow-hidden",
          className
        )}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]">
          <svg className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              onQueryChange?.(e.target.value);
            }}
            placeholder={placeholder}
            className={cn(
              "flex-1 bg-transparent text-sm text-[var(--color-text)]",
              "placeholder:text-[var(--color-text-subtle)]",
              "focus:outline-none"
            )}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={
              flatFiltered[activeIdx] ? `cmd-item-${flatFiltered[activeIdx].id}` : undefined
            }
            role="combobox"
            aria-expanded={filtered.length > 0}
          />
          {loading && <Spinner size="sm" />}
          <kbd className="shrink-0 text-xs text-[var(--color-text-subtle)] border border-[var(--color-border)] rounded px-1 py-0.5">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Commands"
          className="max-h-80 overflow-y-auto py-2"
        >
          {!loading && filtered.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
              No results for &ldquo;{query}&rdquo;
            </li>
          )}
          {Array.from(grouped.entries()).map(([cat, catItems]) => (
            <li key={cat || "__no-cat__"} role="none">
              {cat && (
                <p className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
                  {cat}
                </p>
              )}
              <ul role="none">
                {catItems.map((item) => {
                  const idx = flatFiltered.indexOf(item);
                  const isActive = idx === activeIdx;
                  return (
                    <li
                      key={item.id}
                      id={`cmd-item-${item.id}`}
                      role="option"
                      aria-selected={isActive}
                      aria-disabled={item.disabled}
                      data-active={isActive}
                      onClick={() => handleSelect(item)}
                      onMouseEnter={() => setActiveIdx(idx)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 cursor-pointer",
                        "transition-colors duration-[var(--transition-fast)]",
                        isActive && "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]",
                        !isActive && "text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]",
                        item.disabled && "opacity-50 cursor-not-allowed"
                      )}
                    >
                      {item.icon && (
                        <span className={cn("shrink-0 w-4 h-4 flex items-center justify-center", isActive ? "text-[var(--color-primary-foreground)]" : "text-[var(--color-text-muted)]")}>
                          {item.icon}
                        </span>
                      )}
                      <span className="flex flex-col min-w-0">
                        <span className="text-sm font-medium truncate">
                          {highlight(item.label, query)}
                        </span>
                        {item.description && (
                          <span className={cn("text-xs truncate", isActive ? "text-[var(--color-primary-foreground)]/70" : "text-[var(--color-text-muted)]")}>
                            {item.description}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
