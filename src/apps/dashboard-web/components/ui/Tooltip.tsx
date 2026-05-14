import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";

type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  placement?: TooltipPlacement;
  delayMs?: number;
  className?: string;
}

const placementClasses: Record<TooltipPlacement, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
};

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  placement = "top",
  delayMs = 400,
  className,
}) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useRef(`tooltip-${Math.random().toString(36).slice(2, 9)}`).current;

  const show = useCallback(() => {
    timerRef.current = setTimeout(() => setVisible(true), delayMs);
  }, [delayMs]);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

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
      {visible && (
        <span
          id={tooltipId}
          role="tooltip"
          className={cn(
            "absolute z-50 px-2 py-1 rounded-[var(--radius-sm)]",
            "text-xs font-medium whitespace-nowrap pointer-events-none",
            "bg-[var(--color-text)] text-[var(--color-surface)]",
            "shadow-[var(--shadow-md)]",
            placementClasses[placement],
            className
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
};
