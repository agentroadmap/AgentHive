import { useCallback, useEffect, useRef } from "react";

// Focusable element selectors per WAI-ARIA spec
const FOCUSABLE_SELECTORS = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  "details > summary",
  "audio[controls]",
  "video[controls]",
].join(", ");

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)).filter(
    (el) => !el.closest("[hidden]") && el.offsetParent !== null
  );
}

/**
 * useFocusTrap — traps keyboard focus within a container element while active.
 * Returns a ref to attach to the container.
 */
export function useFocusTrap(active: boolean) {
  const containerRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active || !containerRef.current) return;

    // Save the currently focused element to restore on close
    previousFocusRef.current = document.activeElement as HTMLElement;

    const focusableEls = getFocusableElements(containerRef.current);
    if (focusableEls.length > 0) {
      focusableEls[0].focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !containerRef.current) return;

      const focusable = getFocusableElements(containerRef.current);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [active]);

  return containerRef as React.RefObject<HTMLElement>;
}

/**
 * useKeyboardNav — enables arrow-key navigation within a list of items.
 * Returns a ref to attach to the container.
 */
export function useKeyboardNav(options?: {
  orientation?: "horizontal" | "vertical" | "both";
  onSelect?: (index: number) => void;
}) {
  const { orientation = "vertical", onSelect } = options ?? {};
  const containerRef = useRef<HTMLElement | null>(null);
  const currentIndexRef = useRef(0);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!containerRef.current) return;
      const items = getFocusableElements(containerRef.current);
      if (items.length === 0) return;

      const isVertical = orientation === "vertical" || orientation === "both";
      const isHorizontal = orientation === "horizontal" || orientation === "both";

      let next = currentIndexRef.current;

      if (isVertical && e.key === "ArrowDown") {
        e.preventDefault();
        next = (currentIndexRef.current + 1) % items.length;
      } else if (isVertical && e.key === "ArrowUp") {
        e.preventDefault();
        next = (currentIndexRef.current - 1 + items.length) % items.length;
      } else if (isHorizontal && e.key === "ArrowRight") {
        e.preventDefault();
        next = (currentIndexRef.current + 1) % items.length;
      } else if (isHorizontal && e.key === "ArrowLeft") {
        e.preventDefault();
        next = (currentIndexRef.current - 1 + items.length) % items.length;
      } else if (e.key === "Home") {
        e.preventDefault();
        next = 0;
      } else if (e.key === "End") {
        e.preventDefault();
        next = items.length - 1;
      } else if (e.key === "Enter" || e.key === " ") {
        onSelect?.(currentIndexRef.current);
        return;
      } else {
        return;
      }

      currentIndexRef.current = next;
      items[next].focus();
    },
    [orientation, onSelect]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return containerRef as React.RefObject<HTMLElement>;
}

let announceEl: HTMLElement | null = null;

function getOrCreateAnnouncer(): HTMLElement {
  if (announceEl) return announceEl;

  announceEl = document.createElement("div");
  announceEl.setAttribute("aria-live", "polite");
  announceEl.setAttribute("aria-atomic", "true");
  announceEl.setAttribute("role", "status");
  Object.assign(announceEl.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0,0,0,0)",
    whiteSpace: "nowrap",
    border: "0",
  });
  document.body.appendChild(announceEl);
  return announceEl;
}

/**
 * announce — posts a message to an aria-live region for screen readers.
 */
export function announce(message: string, assertive = false): void {
  const el = getOrCreateAnnouncer();
  el.setAttribute("aria-live", assertive ? "assertive" : "polite");
  el.textContent = "";
  requestAnimationFrame(() => {
    el.textContent = message;
  });
}
