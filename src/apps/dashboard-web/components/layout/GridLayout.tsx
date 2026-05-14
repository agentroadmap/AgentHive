import type React from "react";
import { cn } from "../../lib/cn";

type Cols = 1 | 2 | 3 | 4 | 6 | 12;

export interface GridLayoutProps {
  children: React.ReactNode;
  cols?: Cols;
  smCols?: Cols;
  mdCols?: Cols;
  lgCols?: Cols;
  gap?: "sm" | "md" | "lg";
  className?: string;
}

const colsMap: Record<Cols, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  6: "grid-cols-6",
  12: "grid-cols-12",
};

const smColsMap: Record<Cols, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  6: "sm:grid-cols-6",
  12: "sm:grid-cols-12",
};

const mdColsMap: Record<Cols, string> = {
  1: "md:grid-cols-1",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
  6: "md:grid-cols-6",
  12: "md:grid-cols-12",
};

const lgColsMap: Record<Cols, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  6: "lg:grid-cols-6",
  12: "lg:grid-cols-12",
};

const gapMap: Record<NonNullable<GridLayoutProps["gap"]>, string> = {
  sm: "gap-3",
  md: "gap-4",
  lg: "gap-6",
};

export const GridLayout: React.FC<GridLayoutProps> = ({
  children,
  cols = 1,
  smCols,
  mdCols,
  lgCols,
  gap = "md",
  className,
}) => {
  return (
    <div
      className={cn(
        "grid",
        colsMap[cols],
        smCols && smColsMap[smCols],
        mdCols && mdColsMap[mdCols],
        lgCols && lgColsMap[lgCols],
        gapMap[gap],
        className
      )}
    >
      {children}
    </div>
  );
};

export interface GridItemProps {
  children: React.ReactNode;
  span?: 1 | 2 | 3 | 4 | 6 | 12;
  className?: string;
}

const spanMap: Record<NonNullable<GridItemProps["span"]>, string> = {
  1: "col-span-1",
  2: "col-span-2",
  3: "col-span-3",
  4: "col-span-4",
  6: "col-span-6",
  12: "col-span-12",
};

export const GridItem: React.FC<GridItemProps> = ({ children, span, className }) => {
  return (
    <div className={cn(span && spanMap[span], className)}>
      {children}
    </div>
  );
};
