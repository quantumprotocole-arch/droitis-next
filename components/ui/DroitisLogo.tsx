import React from "react";

export default function DroitisLogo({ className }: { className?: string }) {
  return (
    <div className={className} aria-label="Droitis">
      {/* Simple inline mark inspired by provided logo */}
      <svg viewBox="0 0 128 128" role="img" aria-hidden="true" className="h-full w-full">
        <defs>
          <linearGradient id="droitisMark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0B2233" />
            <stop offset="100%" stopColor="#123449" />
          </linearGradient>
        </defs>
        <path
          d="M24 18h52c22.091 0 40 17.909 40 40s-17.909 40-40 40H24V18zm20 20v52h32c11.046 0 20-8.954 20-20s-8.954-20-20-20H44z"
          fill="url(#droitisMark)"
        />
        <circle cx="98" cy="56" r="7.5" fill="url(#droitisMark)" />
        <circle cx="98" cy="76" r="7.5" fill="url(#droitisMark)" />
        <path d="M90 66h16" stroke="url(#droitisMark)" strokeWidth="10" strokeLinecap="round" />
      </svg>
    </div>
  );
}
