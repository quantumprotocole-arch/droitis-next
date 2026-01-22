import React from "react";

const WORDS = [
  "Jurisprudence",
  "Obligation",
  "Contrat",
  "Responsabilité",
  "Préjudice",
  "Causalité",
  "Droit civil",
  "Procédure",
  "Preuve",
  "Interprétation",
  "Nullité",
  "Faute",
  "Recours",
  "Article",
  "Tribunal",
];

export default function DroitisBackground({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-dvh overflow-hidden bg-white">
      {/* Pastel gradient */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
      >
        <div className="absolute inset-0 bg-gradient-to-br from-rose-200/70 via-white to-sky-200/70" />
        <div className="absolute -top-48 -left-48 h-[28rem] w-[28rem] rounded-full bg-rose-300/35 blur-3xl" />
        <div className="absolute -bottom-48 -right-48 h-[28rem] w-[28rem] rounded-full bg-sky-300/35 blur-3xl" />
      </div>

      {/* Legal words pattern */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.09]"
      >
        <div className="absolute left-[-10%] top-[8%] rotate-[-12deg] whitespace-nowrap text-[44px] font-semibold tracking-tight text-slate-900">
          {WORDS.slice(0, 5).join(" • ")}
        </div>
        <div className="absolute left-[6%] top-[28%] rotate-[10deg] whitespace-nowrap text-[38px] font-semibold tracking-tight text-slate-900">
          {WORDS.slice(5, 10).join(" • ")}
        </div>
        <div className="absolute left-[-6%] top-[50%] rotate-[-8deg] whitespace-nowrap text-[42px] font-semibold tracking-tight text-slate-900">
          {WORDS.slice(10).join(" • ")}
        </div>
      </div>

      {/* Content */}
      <div className="relative">{children}</div>
    </div>
  );
}
