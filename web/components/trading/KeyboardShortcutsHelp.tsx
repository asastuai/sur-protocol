"use client";

interface ShortcutDef {
  key: string;
  label: string;
  category: string;
}

export function KeyboardShortcutsHelp({
  shortcuts,
  onClose,
}: {
  shortcuts: ShortcutDef[];
  onClose: () => void;
}) {
  const categories = [...new Set(shortcuts.map((s) => s.category))];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-sur-surface border border-sur-border rounded-xl w-[340px] max-h-[80vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-sur-border">
          <h3 className="text-sm font-semibold text-sur-text">Keyboard Shortcuts</h3>
          <button
            onClick={onClose}
            className="text-sur-muted hover:text-sur-text text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="p-4 space-y-4">
          {categories.map((cat) => (
            <div key={cat}>
              <div className="text-[9px] font-semibold uppercase tracking-wider text-sur-muted mb-2">
                {cat}
              </div>
              <div className="space-y-1.5">
                {shortcuts
                  .filter((s) => s.category === cat)
                  .map((s) => (
                    <div
                      key={s.key}
                      className="flex items-center justify-between text-[11px]"
                    >
                      <span className="text-sur-text/80">{s.label}</span>
                      <kbd className="px-2 py-0.5 rounded bg-sur-bg border border-sur-border text-[10px] font-mono text-sur-muted min-w-[28px] text-center">
                        {s.key}
                      </kbd>
                    </div>
                  ))}
              </div>
            </div>
          ))}

          <div className="pt-2 border-t border-sur-border text-[10px] text-sur-muted text-center">
            Press <kbd className="px-1.5 py-0.5 rounded bg-sur-bg border border-sur-border font-mono">?</kbd> to toggle this panel
          </div>
        </div>
      </div>
    </div>
  );
}
