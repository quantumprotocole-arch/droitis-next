// app/app/layout.tsx
export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import SignOutButton from '../../components/auth/SignOutButton'
import DroitisLogo from '@/components/ui/DroitisLogo'

function DocIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        d="M7 3h7l3 3v15a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M14 3v4h4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 11h8M8 15h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?reason=auth')
  }

  // UI only: badge discret (vrai statut affiché dans AppClient)
  return (
    <div className="min-h-screen bg-droitis-gradient">
      <div className="min-h-screen bg-white/55 backdrop-blur-[2px]">
        <header className="sticky top-0 z-20 border-b border-white/40 bg-white/60 backdrop-blur-md">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/app" className="flex items-center gap-2">
              <span className="h-8 w-8">
                <DroitisLogo className="h-8 w-8" />
              </span>
              <span className="hidden text-sm font-extrabold tracking-wide text-droitis-ink2 sm:inline">
                Droitis
              </span>
            </Link>

            <div className="flex items-center gap-2 sm:gap-3">
              <Link
                href="/case-reader"
                title="Analyse un PDF/DOCX et génère une fiche"
                className="droitis-btn-secondary px-3 py-2"
              >
                <DocIcon className="h-5 w-5" />
                <span className="hidden sm:inline">Lire une décision</span>
              </Link>

              <Link href="/app/settings" className="droitis-btn-secondary px-3 py-2">
                <span className="hidden sm:inline">Réglages</span>
                <span className="sm:hidden">⚙️</span>
              </Link>

              <span className="hidden items-center gap-2 rounded-full border border-droitis-stroke bg-white/60 px-3 py-1 text-xs font-semibold text-droitis-ink2 sm:flex">
                <span className="h-2 w-2 rounded-full bg-droitis-ink" aria-hidden="true" />
                Compte
              </span>

              <span className="hidden text-xs text-droitis-ink/70 md:inline">{user.email}</span>
              <SignOutButton />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-4">{children}</main>
      </div>
    </div>
  )
}
