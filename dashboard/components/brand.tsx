// The Mem·Sum mark: a crescent dumpling on the diagonal, the drawn twin of
// the 🥟 that agents use in chat. Filled is the identity register; pleats are
// mask cuts so the glyph sits on any surface. The wordmark keeps title case —
// the dot between capitals is the brand's atom — with warmth carried by the
// rounded face and the persimmon accent, not by lowercasing.

export function DumplingMark({ size = 32, title = "Mem·Sum" }: { size?: number; title?: string }) {
  return (
    <svg
      aria-label={title}
      height={size}
      role="img"
      viewBox="0 0 100 100"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <defs>
        <mask id="ms-pleats">
          <rect fill="white" height="100" width="100" />
          <g
            fill="none"
            stroke="black"
            strokeLinecap="round"
            strokeWidth="5"
            transform="rotate(-35 50 50) translate(50 50) scale(0.96) translate(-50 -48)"
          >
            <path d="M38 30 Q36 38 40 44" />
            <path d="M52 27 Q50 36 54 43" />
            <path d="M66 31 Q63 39 66 45" />
          </g>
        </mask>
      </defs>
      <g transform="rotate(-35 50 50) translate(50 50) scale(0.96) translate(-50 -48)">
        <path
          d="M14 62 Q14 46 26 36 Q36 27 50 27 Q64 27 74 36 Q86 46 86 62 Q86 70 78 70 L22 70 Q14 70 14 62 Z"
          fill="var(--accent)"
          mask="url(#ms-pleats)"
        />
      </g>
    </svg>
  );
}

export function Wordmark({ className = "text-3xl" }: { className?: string }) {
  return (
    <span className={`font-brand font-bold tracking-tight ${className}`}>
      Mem<span className="text-accent">·</span>Sum
    </span>
  );
}

export function Lockup({ markSize = 40, className = "text-3xl" }: { markSize?: number; className?: string }) {
  return (
    <span className="inline-flex items-center gap-3">
      <DumplingMark size={markSize} />
      <Wordmark className={className} />
    </span>
  );
}
