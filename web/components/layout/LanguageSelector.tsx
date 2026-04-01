"use client";

import { useState, useRef, useEffect } from "react";
import { LOCALES, getLocale, setLocale, type Locale } from "@/lib/i18n";

export function LanguageSelector() {
  const [current, setCurrent] = useState<Locale>("en");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrent(getLocale());
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = (locale: Locale) => {
    setLocale(locale);
    setCurrent(locale);
    setOpen(false);
    // Trigger re-render across the app
    window.dispatchEvent(new Event("sur-locale-change"));
  };

  const currentLocale = LOCALES.find(l => l.key === current) || LOCALES[0];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label="Select language"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-2 py-1.5 rounded text-[11px] text-sur-muted hover:text-sur-text hover:bg-white/[0.04] transition-colors"
        title="Language"
      >
        <span>{currentLocale.flag}</span>
        <span className="hidden sm:inline">{currentLocale.key.toUpperCase()}</span>
        <svg width="8" height="5" viewBox="0 0 8 5" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1 1L4 4L7 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 bg-sur-surface border border-sur-border rounded-lg shadow-xl z-50 min-w-[140px] py-1 animate-fade-in">
          {LOCALES.map((locale) => (
            <button
              key={locale.key}
              onClick={() => handleSelect(locale.key)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12px] hover:bg-white/[0.04] transition-colors ${
                current === locale.key ? "text-sur-accent font-medium" : "text-sur-text"
              }`}
            >
              <span>{locale.flag}</span>
              <span>{locale.label}</span>
              {current === locale.key && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="ml-auto text-sur-accent">
                  <path d="M2 5L4 7L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
