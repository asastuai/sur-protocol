"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "long" | "short";
type Size = "xs" | "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary: "bg-sur-accent text-black hover:bg-sur-accent/90 font-semibold",
  secondary: "bg-sur-border/50 text-sur-text hover:bg-sur-border",
  danger: "bg-sur-red/15 text-sur-red border border-sur-red/30 hover:bg-sur-red/25",
  ghost: "text-sur-muted hover:text-sur-text hover:bg-white/[0.04]",
  long: "bg-sur-green text-black hover:bg-sur-green/90 font-bold",
  short: "bg-sur-red text-white hover:bg-sur-red/90 font-bold",
};

const sizeClasses: Record<Size, string> = {
  xs: "text-[9px] px-2 py-1 rounded",
  sm: "text-[11px] px-3 py-1.5 rounded",
  md: "text-xs px-4 py-2 rounded-lg",
  lg: "text-sm px-5 py-3 rounded-lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", loading, disabled, className = "", children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`inline-flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
        {...props}
      >
        {loading && (
          <svg className="animate-spin -ml-0.5 mr-1.5 h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
