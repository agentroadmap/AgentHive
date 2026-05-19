import type React from "react";
import { cn } from "../../lib/cn";

export interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
  siblingCount?: number;
}

function buildRange(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function getPages(page: number, total: number, siblings: number): (number | "ellipsis")[] {
  if (total <= 7) return buildRange(1, total);

  const leftSib = Math.max(page - siblings, 2);
  const rightSib = Math.min(page + siblings, total - 1);

  const showLeftEllipsis = leftSib > 2;
  const showRightEllipsis = rightSib < total - 1;

  if (!showLeftEllipsis && showRightEllipsis) {
    return [...buildRange(1, 3 + 2 * siblings), "ellipsis", total];
  }
  if (showLeftEllipsis && !showRightEllipsis) {
    return [1, "ellipsis", ...buildRange(total - 2 - 2 * siblings, total)];
  }
  return [1, "ellipsis", ...buildRange(leftSib, rightSib), "ellipsis", total];
}

export const Pagination: React.FC<PaginationProps> = ({
  page,
  totalPages,
  onPageChange,
  className,
  siblingCount = 1,
}) => {
  if (totalPages <= 1) return null;

  const pages = getPages(page, totalPages, siblingCount);

  const btnBase = cn(
    "inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] text-sm",
    "transition-colors duration-[var(--transition-fast)]",
    "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)] focus-visible:outline-offset-2",
    "disabled:opacity-40 disabled:cursor-not-allowed"
  );

  return (
    <nav aria-label="Pagination" className={cn("flex items-center gap-1", className)}>
      <button
        type="button"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        className={cn(
          btnBase,
          "border border-[var(--color-border)] text-[var(--color-text-muted)]",
          "hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
        )}
      >
        ‹
      </button>

      {pages.map((p, i) =>
        p === "ellipsis" ? (
          <span key={`ellipsis-${i}`} className="w-8 h-8 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            aria-label={`Page ${p}`}
            aria-current={p === page ? "page" : undefined}
            onClick={() => onPageChange(p)}
            className={cn(
              btnBase,
              p === page
                ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border border-[var(--color-primary)]"
                : "border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
            )}
          >
            {p}
          </button>
        )
      )}

      <button
        type="button"
        aria-label="Next page"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
        className={cn(
          btnBase,
          "border border-[var(--color-border)] text-[var(--color-text-muted)]",
          "hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
        )}
      >
        ›
      </button>
    </nav>
  );
};
