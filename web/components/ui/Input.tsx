"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  suffix?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, suffix, error, className = "", ...props }, ref) => {
    return (
      <div>
        {label && (
          <label className="text-[9px] text-sur-muted font-medium uppercase tracking-wider">
            {label}
          </label>
        )}
        <div className={`relative ${label ? "mt-1" : ""}`}>
          <input
            ref={ref}
            className={`w-full bg-sur-bg border rounded px-2.5 py-1.5 text-[11px] tabular-nums outline-none transition-colors ${
              error
                ? "border-sur-red/50 focus:border-sur-red"
                : "border-sur-border focus:border-sur-accent/50"
            } ${suffix ? "pr-10" : ""} ${className}`}
            {...props}
          />
          {suffix && (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-sur-muted pointer-events-none">
              {suffix}
            </span>
          )}
        </div>
        {error && (
          <p className="mt-0.5 text-[9px] text-sur-red">{error}</p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
