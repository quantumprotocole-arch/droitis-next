'use client'

import React, { useId, useState } from "react";

export default function Accordion({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl2 border border-droitis-stroke bg-white/55">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-droitis-ink"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{title}</span>
        <span aria-hidden="true" className="text-lg leading-none">
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <div id={id} className="px-4 pb-4 text-[14px] leading-relaxed text-droitis-ink">
          {children}
        </div>
      )}
    </div>
  );
}
