import type React from "react";
import { useState, useRef, useCallback, useId } from "react";
import { cn } from "../../lib/cn";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  placement?: TooltipPlacement;
  delay?: number;
  className?: string;
  disabled?: boolean;
}

const placementClasses: Record<TooltipPlacement, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
};

const arrowClasses: Record<TooltipPlacement, string> = {
  top: "top-full left-1/2 -translate-x-1/2 border-t-[var(--color-text)] border-l-transparent border-r-transparent border-b-transparent border-4",
  bottom: "bottom-full left-1/2 -translate-x-1/2 border-b-[var(--color-text)] border-l-transparent border-r-transparent border-t-transparent border-4",
  left: "left-full top-1/2 -translate-y-1/2 border-l-[var(--color-text)] border-t-transparent border-b-transparent border-r-transparent border-4",
  right: "right-full top-1/2 -translate-y-1/2 border-r-[var(--color-text)] border-t-transparent border-b-transparent border-l-transparent border-4",
};

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  placement = "top",
  delay = 400,
  className,
  disabled = false,
}) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();

  const show = useCallback(() => {
    if (disabled) return;
    timerRef.current = setTimeout(() => setVisible(true), delay);
  }, [delay, disabled]);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  const child = React.cloneElement(children, {
    "aria-describedby": visible ? tooltipId : undefined,
    onMouseEnter: (e: React.MouseEvent) => {
      show();
      children.props.onMouseEnter?.(e);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      hide();
      children.props.onMouseLeave?.(e);
    },
    onFocus: (e: React.FocusEvent) => {
      show();
      children.props.onFocus?.(e);
    },
    onBlur: (e: React.FocusEvent) => {
      hide();
      children.props.onBlur?.(e);
    },
  });

  return (
    <span className="relative inline-flex">
      {child}
      {visible && !disabled && (
        <span
          id={tooltipId}
          role="tooltip"
          className={cn(
            "absolute z-50 whitespace-nowrap pointer-events-none",
            "px-2 py-1 rounded-[var(--radius-sm)]",
            "text-xs font-medium",
            "bg-[var(--color-text)] text-[var(--color-surface)]",
            "shadow-[var(--shadow-md)]",
            placementClasses[placement],
            className
          )}
        >
          {content}
          <span className={cn("absolute", arrowClasses[placement])} aria-hidden="true" />
        </span>
      )}
    </span>
  );
};
