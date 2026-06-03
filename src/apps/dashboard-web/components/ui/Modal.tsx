import type React from "react";
import { useEffect, useId, useRef } from "react";
import { cn } from "../../lib/cn";
import { useFocusTrap } from "../../lib/a11y";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidthClass?: string;
  disableEscapeClose?: boolean;
  actions?: React.ReactNode;
  className?: string;
  stackLevel?: number;
}

let openModalCount = 0;

const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  maxWidthClass = "max-w-2xl",
  disableEscapeClose = false,
  actions,
  className,
  stackLevel,
}) => {
  const generatedTitleId = useId();
  const titleId = `modal-title-${generatedTitleId}`;
  const containerRef = useFocusTrap(isOpen);
  const zBase = stackLevel ?? 50;

  useEffect(() => {
    if (!isOpen) return;

    openModalCount++;
    document.body.style.overflow = "hidden";

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !disableEscapeClose) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);

    return () => {
      openModalCount = Math.max(0, openModalCount - 1);
      if (openModalCount === 0) {
        document.body.style.overflow = "";
      }
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, disableEscapeClose, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: zBase }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="absolute inset-0 bg-[var(--color-surface-overlay)]"
        aria-hidden="true"
      />
      <div
        ref={containerRef as React.RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          "relative bg-[var(--color-surface)] rounded-[var(--radius-lg)]",
          "shadow-[var(--shadow-lg)] w-full max-h-[94vh] overflow-y-auto",
          "transition-colors duration-[var(--transition-normal)]",
          maxWidthClass,
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={cn(
            "sticky top-0 z-10 flex items-center justify-between px-6 pt-4 pb-3",
            "border-b border-[var(--color-border)]",
            "bg-[var(--color-surface)] backdrop-blur supports-[backdrop-filter]:bg-[var(--color-surface)]/90"
          )}
        >
          <h2
            id={titleId}
            className="text-base font-semibold text-[var(--color-text)]"
          >
            {title}
          </h2>
          <div className="flex items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={onClose}
              className={cn(
                "flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)]",
                "text-[var(--color-text-muted)] text-2xl leading-none",
                "hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]",
                "transition-colors duration-[var(--transition-fast)]",
                "focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus-ring)] focus-visible:outline-offset-2"
              )}
              aria-label="Close modal"
            >
              ×
            </button>
          </div>
        </div>
        <div className="px-6 pt-4 pb-6">{children}</div>
      </div>
    </div>
  );
};

export default Modal;
export { Modal };
