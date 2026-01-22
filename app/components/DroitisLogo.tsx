import React from "react";

export default function DroitisLogo({ compact }: { compact?: boolean }) {
  return (
    <div className="inline-flex items-center gap-2">
      <div className="h-9 w-9 rounded-2xl bg-gradient-to-br from-rose-400 to-sky-400 shadow-soft" />
      <div className="leading-tight">
        <div className="text-base font-semibold tracking-tight text-slate-900">
          Droitis
        </div>
        {!compact && (
          <div className="text-xs text-slate-500">
            Assistance juridique pour étudiants
          </div>
        )}
      </div>
    </div>
  );
}
