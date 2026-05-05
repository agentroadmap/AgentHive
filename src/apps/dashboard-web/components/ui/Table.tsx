import type React from "react";
import { useState, useMemo } from "react";
import { cn } from "../../lib/cn";
import { Spinner } from "./Spinner";

export interface TableColumn<T> {
  key: string;
  header: string;
  accessor: (row: T) => React.ReactNode;
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
  className?: string;
  headerClassName?: string;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  data: T[];
  keyExtractor: (row: T) => string;
  loading?: boolean;
  emptyMessage?: string;
  emptyAction?: React.ReactNode;
  selectable?: boolean;
  onSelectionChange?: (selectedKeys: string[]) => void;
  bulkActions?: React.ReactNode;
  pageSize?: number;
  className?: string;
  "aria-label"?: string;
}

type SortDir = "asc" | "desc" | null;

function SortIndicator({ dir }: { dir: SortDir }) {
  return (
    <span className="ml-1 inline-flex flex-col leading-none text-[var(--color-text-subtle)]" aria-hidden="true">
      <span className={cn("text-[8px]", dir === "asc" ? "text-[var(--color-primary)]" : "")}>▲</span>
      <span className={cn("text-[8px]", dir === "desc" ? "text-[var(--color-primary)]" : "")}>▼</span>
    </span>
  );
}

export function Table<T>({
  columns,
  data,
  keyExtractor,
  loading = false,
  emptyMessage = "No results found",
  emptyAction,
  selectable = false,
  onSelectionChange,
  bulkActions,
  pageSize: initialPageSize = 25,
  className,
  "aria-label": ariaLabel,
}: TableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [pageSize] = useState(initialPageSize);

  const sorted = useMemo(() => {
    if (!sortKey || !sortDir) return data;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return data;
    return [...data].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir, columns]);

  const totalPages = Math.ceil(sorted.length / pageSize);
  const paged = sorted.slice(page * pageSize, (page + 1) * pageSize);

  const handleSort = (key: string) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortKey(null);
      setSortDir(null);
    }
    setPage(0);
  };

  const toggleRow = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onSelectionChange?.([...next]);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedKeys.size === paged.length) {
      setSelectedKeys(new Set());
      onSelectionChange?.([]);
    } else {
      const keys = new Set(paged.map(keyExtractor));
      setSelectedKeys(keys);
      onSelectionChange?.([...keys]);
    }
  };

  const allSelected = paged.length > 0 && selectedKeys.size === paged.length;
  const someSelected = selectedKeys.size > 0 && !allSelected;

  return (
    <div className={cn("flex flex-col gap-0", className)}>
      {selectable && selectedKeys.size > 0 && (
        <div
          className={cn(
            "flex items-center gap-3 px-4 py-2 rounded-t-[var(--radius-md)]",
            "bg-[var(--color-info-bg)] border border-b-0 border-[var(--color-info)]",
            "text-sm text-[var(--color-info-fg)]"
          )}
        >
          <span className="font-medium">{selectedKeys.size} selected</span>
          {bulkActions}
        </div>
      )}

      <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
        <table
          aria-label={ariaLabel}
          className="w-full text-sm text-[var(--color-text)] border-collapse"
        >
          <thead>
            <tr className="bg-[var(--color-surface-elevated)] border-b border-[var(--color-border)]">
              {selectable && (
                <th className="w-10 px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleAll}
                    aria-label="Select all rows"
                    className="rounded border-[var(--color-border)] accent-[var(--color-primary)]"
                  />
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={cn(
                    "px-4 py-3 text-left font-semibold text-[var(--color-text-muted)]",
                    col.sortable &&
                      "cursor-pointer select-none hover:text-[var(--color-text)] transition-colors duration-[var(--transition-fast)]",
                    col.headerClassName
                  )}
                  onClick={col.sortable ? () => handleSort(col.key) : undefined}
                  aria-sort={
                    sortKey === col.key
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  <span className="inline-flex items-center">
                    {col.header}
                    {col.sortable && (
                      <SortIndicator dir={sortKey === col.key ? sortDir : null} />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={columns.length + (selectable ? 1 : 0)}
                  className="px-4 py-12 text-center"
                >
                  <Spinner size="lg" aria-label="Loading table data" />
                </td>
              </tr>
            ) : paged.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (selectable ? 1 : 0)}
                  className="px-4 py-12 text-center text-[var(--color-text-muted)]"
                >
                  <div className="flex flex-col items-center gap-3">
                    <p className="text-sm">{emptyMessage}</p>
                    {emptyAction}
                  </div>
                </td>
              </tr>
            ) : (
              paged.map((row) => {
                const key = keyExtractor(row);
                const isSelected = selectedKeys.has(key);
                return (
                  <tr
                    key={key}
                    className={cn(
                      "border-b border-[var(--color-border)] last:border-0",
                      "transition-colors duration-[var(--transition-fast)]",
                      isSelected
                        ? "bg-[var(--color-info-bg)]"
                        : "hover:bg-[var(--color-surface-hover)]"
                    )}
                  >
                    {selectable && (
                      <td className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(key)}
                          aria-label={`Select row ${key}`}
                          className="rounded border-[var(--color-border)] accent-[var(--color-primary)]"
                        />
                      </td>
                    )}
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cn("px-4 py-3", col.className)}
                      >
                        {col.accessor(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div
          className={cn(
            "flex items-center justify-between px-4 py-3",
            "border border-t-0 border-[var(--color-border)] rounded-b-[var(--radius-md)]",
            "text-sm text-[var(--color-text-muted)]"
          )}
        >
          <span>
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, sorted.length)} of{" "}
            {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(0)}
              disabled={page === 0}
              className={cn(
                "px-2 py-1 rounded-[var(--radius-sm)] text-xs",
                "hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed",
                "transition-colors duration-[var(--transition-fast)]",
                "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)]"
              )}
              aria-label="First page"
            >
              «
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className={cn(
                "px-2 py-1 rounded-[var(--radius-sm)] text-xs",
                "hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed",
                "transition-colors duration-[var(--transition-fast)]",
                "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)]"
              )}
              aria-label="Previous page"
            >
              ‹
            </button>
            <span className="px-2">
              {page + 1} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
              className={cn(
                "px-2 py-1 rounded-[var(--radius-sm)] text-xs",
                "hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed",
                "transition-colors duration-[var(--transition-fast)]",
                "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)]"
              )}
              aria-label="Next page"
            >
              ›
            </button>
            <button
              type="button"
              onClick={() => setPage(totalPages - 1)}
              disabled={page === totalPages - 1}
              className={cn(
                "px-2 py-1 rounded-[var(--radius-sm)] text-xs",
                "hover:bg-[var(--color-surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed",
                "transition-colors duration-[var(--transition-fast)]",
                "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)]"
              )}
              aria-label="Last page"
            >
              »
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
