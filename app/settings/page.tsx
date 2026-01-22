// app/app/settings/page.tsx
'use client'

import Link from 'next/link'
import { useState } from 'react'
import Toggle from '@/components/ui/Toggle'

export default function SettingsPage() {
  // UI only
  const [compactMode, setCompactMode] = useState(false)

  return (
    <div className="space-y-4">
      <div className="rounded-xl2 border border-white/50 bg-white/55 p-4 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-extrabold tracking-wide text-droitis-ink2">Réglages</div>
            <div className="mt-1 text-xs text-droitis-ink/70">Paramètres UI minimal (Phase 1).</div>
          </div>
          <Link href="/app" className="droitis-btn-secondary px-3 py-2">
            Retour au Chat
          </Link>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-xl2 border border-droitis-stroke bg-white/65 p-4">
            <Toggle
              checked={compactMode}
              onChange={setCompactMode}
              label="Mode compact"
              description="Réduit légèrement l’espacement (UI uniquement)."
            />
          </div>

          <div className="rounded-xl2 border border-droitis-stroke bg-white/65 p-4">
            <div className="text-sm font-semibold text-droitis-ink">Confidentialité</div>
            <div className="mt-2 text-xs text-droitis-ink/70">
              Les contenus envoyés servent à répondre à ta demande. Pour une décision, privilégie Case Reader.
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl2 border border-white/50 bg-white/55 p-4 shadow-soft">
        <div className="text-sm font-extrabold tracking-wide text-droitis-ink2">Support</div>
        <div className="mt-2 text-xs text-droitis-ink/70">
          Si tu observes un bug UI, capture l’écran + URL + heure et envoie au support.
        </div>
      </div>
    </div>
  )
}
