"use client";

import { useEffect, useCallback, useRef, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  width?: string;
}

const FOCUSABLE_SELECTORS =
  'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, children, width = "w-[400px]" }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = title ? "modal-title" : undefined;

  const handleEsc = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  // Focus trap
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)
    ).filter((el) => !el.closest("[aria-hidden='true']"));
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
  }, []);

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleEsc);
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    // Move focus into the dialog
    const frame = requestAnimationFrame(() => {
      if (!dialogRef.current) return;
      const first = dialogRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTORS);
      first?.focus();
    });
    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      cancelAnimationFrame(frame);
    };
  }, [open, handleEsc, handleKeyDown]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      aria-hidden="true"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`bg-sur-surface border border-sur-border rounded-xl shadow-2xl max-h-[85vh] overflow-y-auto ${width}`}
        onClick={(e) => e.stopPropagation()}
        aria-hidden="false"
      >
        {title && (
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-sur-border">
            <h3 id="modal-title" className="text-sm font-semibold text-sur-text">{title}</h3>
            <button
              onClick={onClose}
              aria-label="Close dialog"
              className="text-sur-muted hover:text-sur-text text-lg leading-none transition-colors"
            >
              &times;
            </button>
          </div>
        )}
        <div className={title ? "p-5" : ""}>{children}</div>
      </div>
    </div>
  );
}
