import React, { useState } from 'react';

export interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg';
  showText?: boolean;
  className?: string;
  subtitle?: string;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  size = 'md',
  showText = false,
  className = '',
  subtitle = 'Central Governance & Compliance Engine',
}) => {
  const [imgError, setImgError] = useState(false);

  // Size configurations
  const sizeMap = {
    sm: {
      emblem: 'w-7 h-7',
      padding: 'p-0.5',
      title: 'text-xs font-bold',
      subtitle: 'text-[9px]',
      gap: 'gap-2',
    },
    md: {
      emblem: 'w-9 h-9',
      padding: 'p-1',
      title: 'text-sm font-extrabold',
      subtitle: 'text-[10px]',
      gap: 'gap-2.5',
    },
    lg: {
      emblem: 'w-12 h-12 sm:w-14 sm:h-14',
      padding: 'p-1 sm:p-1.5',
      title: 'text-base sm:text-lg font-black',
      subtitle: 'text-[11px] sm:text-xs',
      gap: 'gap-3',
    },
  };

  const current = sizeMap[size];

  return (
    <div className={`inline-flex items-center ${current.gap} select-none ${className}`}>
      {/* Tactical Circular Emblem Shell */}
      <div
        className={`relative ${current.emblem} ${current.padding} shrink-0 rounded-full bg-[#090d16] border border-cyan-500/60 shadow-[0_0_12px_rgba(6,182,212,0.35),0_0_2px_rgba(217,70,239,0.3)] ring-1 ring-cyan-400/40 transition-all duration-300 group-hover:border-cyan-400 group-hover:shadow-[0_0_18px_rgba(6,182,212,0.5),0_0_4px_rgba(217,70,239,0.4)]`}
      >
        {/* Ambient Chromatic Aberration Glow Overlay */}
        <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-cyan-500/15 via-transparent to-fuchsia-500/10 pointer-events-none" />

        {!imgError ? (
          <img
            src="/assets/logo.png"
            alt="Pitch Black Cyber Emblem"
            onError={() => setImgError(true)}
            className="w-full h-full object-contain rounded-full drop-shadow-[0_0_4px_rgba(6,182,212,0.4)]"
          />
        ) : (
          /* High-fidelity SVG Fallback Emblem */
          <svg
            viewBox="0 0 100 100"
            className="w-full h-full"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle cx="50" cy="50" r="46" stroke="#06b6d4" strokeWidth="3" opacity="0.8" />
            <circle cx="50" cy="50" r="41" stroke="#0891b2" strokeWidth="1" strokeDasharray="4 3" />
            <circle cx="50" cy="50" r="30" fill="#090d16" stroke="#d946ef" strokeWidth="1.5" opacity="0.7" />
            <path
              d="M50 20L68 34V60L50 80L32 60V34L50 20Z"
              fill="url(#fallbackGrad)"
              stroke="#06b6d4"
              strokeWidth="2"
            />
            <circle cx="50" cy="50" r="6" fill="#06b6d4" />
            <defs>
              <linearGradient id="fallbackGrad" x1="32" y1="20" x2="68" y2="80" gradientUnits="userSpaceOnUse">
                <stop stopColor="#0891b2" />
                <stop offset="1" stopColor="#090d16" />
              </linearGradient>
            </defs>
          </svg>
        )}
      </div>

      {/* Typography Block */}
      {showText && (
        <div className="flex flex-col text-left leading-tight">
          <span className={`${current.title} text-white tracking-tight flex items-center gap-1.5`}>
            Event Horizon: Singularity
          </span>
          <span className={`${current.subtitle} text-cyan-400 font-mono tracking-wider uppercase mt-0.5 truncate`}>
            {subtitle}
          </span>
        </div>
      )}
    </div>
  );
};
