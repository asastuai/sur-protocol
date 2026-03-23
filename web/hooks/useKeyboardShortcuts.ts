"use client";

import { useEffect, useCallback, useState } from "react";

export interface ShortcutAction {
  key: string;
  label: string;
  category: string;
  action: () => void;
}

/** Returns true if the user is typing in an input/textarea/contenteditable */
function isInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/**
 * Global keyboard shortcuts hook.
 * Only fires when no input is focused.
 * Returns [showHelp, setShowHelp] for the help overlay.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutAction[]) {
  const [showHelp, setShowHelp] = useState(false);

  const handler = useCallback(
    (e: KeyboardEvent) => {
      if (isInputFocused()) return;

      // ? or / toggles help
      if (e.key === "?" || (e.key === "/" && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }

      // Escape closes help
      if (e.key === "Escape") {
        if (showHelp) {
          setShowHelp(false);
          e.preventDefault();
          return;
        }
      }

      const match = shortcuts.find(
        (s) => s.key.toLowerCase() === e.key.toLowerCase()
      );
      if (match) {
        e.preventDefault();
        match.action();
      }
    },
    [shortcuts, showHelp]
  );

  useEffect(() => {
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handler]);

  return [showHelp, setShowHelp] as const;
}
