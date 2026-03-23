"use client";

/** Pulsing skeleton placeholder — matches SUR dark theme */
export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={`animate-pulse rounded bg-white/[0.06] ${className}`}
      style={style}
    />
  );
}

/** Skeleton shaped like a text line */
export function SkeletonLine({ width = "w-full" }: { width?: string }) {
  return <Skeleton className={`h-3 ${width}`} />;
}

/** Skeleton for a stat card */
export function SkeletonCard() {
  return (
    <div className="bg-sur-surface border border-sur-border rounded-xl p-4 space-y-3">
      <Skeleton className="h-2.5 w-16" />
      <Skeleton className="h-6 w-24" />
      <Skeleton className="h-2 w-20" />
    </div>
  );
}

/** Skeleton for an orderbook row */
export function SkeletonOrderbookRow() {
  return (
    <div className="grid grid-cols-3 px-3 py-[3px] gap-2">
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-3/4 ml-auto" />
      <Skeleton className="h-3 w-1/2 ml-auto" />
    </div>
  );
}

/** Skeleton for the orderbook */
export function SkeletonOrderbook() {
  return (
    <div className="space-y-1 py-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <SkeletonOrderbookRow key={`ask-${i}`} />
      ))}
      <div className="px-3 py-2">
        <Skeleton className="h-5 w-28 mx-auto" />
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <SkeletonOrderbookRow key={`bid-${i}`} />
      ))}
    </div>
  );
}

/** Skeleton for the chart area */
export function SkeletonChart() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-8">
      <div className="w-full max-w-md space-y-2">
        <div className="flex items-end gap-1 h-32">
          {Array.from({ length: 24 }).map((_, i) => (
            <Skeleton
              key={i}
              className="flex-1"
              style={{ height: `${20 + Math.random() * 80}%` } as React.CSSProperties}
            />
          ))}
        </div>
        <Skeleton className="h-2 w-full" />
      </div>
      <span className="text-[10px] text-sur-muted">Loading chart...</span>
    </div>
  );
}

/** Skeleton for positions table */
export function SkeletonTable({ rows = 3, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-0">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3 border-b border-sur-border/30">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              className={`h-3 ${c === 0 ? "w-20" : c === cols - 1 ? "w-16" : "w-14"}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
