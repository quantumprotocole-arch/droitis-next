// app/reset-password/page.tsx
'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '../../lib/supabase/client'
import BrandBackground from '@/components/ui/BrandBackground'
import DroitisLogo from '@/components/ui/DroitisLogo'

export default function ResetPasswordPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setMsg(null)
    setLoading(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      setMsg('Mot de passe mis à jour. Tu peux te connecter.')
      setTimeout(() => router.push('/login'), 300)
    } catch (err: any) {
      setMsg(err?.message ?? 'Une erreur est survenue.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <BrandBackground>
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <div className="droitis-card">
          <div className="px-8 pb-8 pt-7">
            <div className="flex flex-col items-center gap-4">
              <div className="h-14 w-14">
                <DroitisLogo className="h-14 w-14" />
              </div>
              <h1 className="text-center text-[15px] font-extrabold tracking-[0.12em] text-droitis-ink2">
                NOUVEAU MOT DE PASSE
              </h1>
              {msg && (
                <div className="w-full rounded-md border border-droitis-stroke bg-white/60 px-3 py-2 text-sm">
                  {msg}
                </div>
              )}
            </div>

            <form onSubmit={onSubmit} className="mt-6 space-y-5">
              <label className="block">
                <span className="droitis-label">MOT DE PASSE</span>
                <input
                  className="droitis-input mt-2"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </label>

              <button type="submit" disabled={loading} className="droitis-btn w-full">
                {loading ? '...' : 'Mettre à jour'}
              </button>
            </form>

            <div className="mt-5 flex items-center justify-between text-[13px] font-semibold text-droitis-ink2">
              <Link className="underline underline-offset-4" href="/login">
                Retour connexion
              </Link>
              <Link className="underline underline-offset-4" href="/forgot-password">
                Renvoyer un lien
              </Link>
            </div>
          </div>
        </div>
      </div>
    </BrandBackground>
  )
}
