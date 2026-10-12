import React from 'react';
import { clsx } from 'clsx';

export type BadgeTone = 'neutral' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'indigo' | 'brand';
export type BadgeSize = 'xs' | 'sm';

// Static strings so Tailwind can see every class. All tones are tuned for the dark enclave shell (AA on slate-900/950).
const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-800 text-slate-300 border-slate-700',
  cyan: 'bg-cyan-950/60 text-cyan-300 border-cyan-800/60',
  emerald: 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60',
  amber: 'bg-amber-950/60 text-amber-300 border-amber-800/60',
  rose: 'bg-rose-950/60 text-rose-300 border-rose-800/60',
  indigo: 'bg-indigo-950/60 text-indigo-300 border-indigo-800/60',
  brand: 'bg-brand-950/60 text-brand-300 border-brand-800/60',
};

const SIZES: Record<BadgeSize, string> = {
  xs: 'px-1.5 py-0.5 text-xs',
  sm: 'px-2 py-1 text-xs',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Fully rounded pill (default) or a squarer tag. */
  pill?: boolean;
  mono?: boolean;
}

/**
 * Vertically centered badge / pill. Use for status tags, counts and framework labels.
 * Icons passed as children are centered with the text.
 */
export const Badge: React.FC<BadgeProps> = ({
  tone = 'neutral',
  size = 'xs',
  pill = true,
  mono = false,
  className,
  children,
  ...rest
}) => (
  <span
    className={clsx(
      'badge gap-1 border font-semibold',
      TONES[tone],
      SIZES[size],
      pill ? 'rounded-full' : 'rounded-md',
      mono && 'font-mono',
      className
    )}
    {...rest}
  >
    {children}
  </span>
);

export default Badge;
