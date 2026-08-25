"use client";

import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  size?: number;
}

/**
 * HermOS H monogram mark — emerald accent on theme-aware background.
 * Matches the favicon.svg design language.
 */
export function HermOSLogo({ className, size = 28 }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="7" fill="var(--background)" />
      <path
        d="M10 8v16M22 8v16M10 16h12"
        stroke="var(--brand)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="16" cy="24.5" r="1.5" fill="var(--brand)" opacity="0.6" />
    </svg>
  );
}

interface LogoWordmarkProps {
  className?: string;
  size?: number;
  showText?: boolean;
}

export function HermOSWordmark({
  className,
  size = 24,
  showText = true,
}: LogoWordmarkProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <HermOSLogo size={size} />
      {showText && (
        <span className="font-semibold tracking-tight text-foreground text-[15px]">
          HermOS
        </span>
      )}
    </div>
  );
}
