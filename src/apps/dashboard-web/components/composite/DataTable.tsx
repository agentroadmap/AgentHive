import type React from "react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { Input } from "../ui/Input";
import { Table } from "../ui/Table";
import type { TableColumn, TableProps } from "../ui/Table";

export type { TableColumn };

export interface DataTableProps<T> extends Omit<TableProps<T>, "data"> {
  data: T[];
  searchable?: boolean;
  searchPlaceholder?: string;
  searchFilter?: (row: T, query: string) => boolean;
  filterControls?: React.ReactNode;
  headerActions?: React.ReactNode;
  title?: string;
  className?: string;
}

export function DataTable<T>({
  data,
  searchable = false,
  searchPlaceholder = "Search…",
  searchFilter,
  filterControls,
  headerActions,
  title,
  className,
  ...tableProps
}: DataTableProps<T>) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!searchable || !query.trim() || !searchFilter) return data;
    const q = query.toLowerCase();
    return data.filter((row) => searchFilter(row, q));
  }, [data, query, searchable, searchFilter]);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {(title || searchable || filterControls || headerActions) && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
            {title && (
              <h2 className="text-base font-semibold text-[var(--color-text)] shrink-0">
                {title}
              </h2>
            )}
            {searchable && (
              <div className="flex-1 min-w-[200px] max-w-sm">
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label="Filter results"
                  fullWidth
                />
              </div>
            )}
            {filterControls}
          </div>
          {headerActions && (
            <div className="flex items-center gap-2 shrink-0">{headerActions}</div>
          )}
        </div>
      )}
      <Table
        {...tableProps}
        data={filtered}
        emptyMessage={
          query.trim()
            ? `No results for "${query}"`
            : tableProps.emptyMessage
        }
      />
    </div>
  );
}
