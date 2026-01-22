'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '../../lib/supabase/client'
import BrandBackground from '@/components/ui/BrandBackground'
import DroitisLogo from '@/components/ui/DroitisLogo'

type Mode = 'login' | 'signup' | 'reset'

export default function LoginForm({
  reason,
  initialMode = 'login',
  standalone = false,
}: {
  reason: string | null
  initialMode?: Mode
  /** Quand true: page dédiée (signup/forgot), on affiche moins de switch inline */
  standalone?: boolean
}) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [mode, setMode] = useState<Mode>(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)
    setLoading(true)

    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        router.push('/app')
        return
      }

      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        setMessage('Compte créé. Vérifie ton courriel si une confirmation est requise, puis connecte-toi.')
        if (standalone) setTimeout(() => router.push('/login'), 300)
        return
      }

      // reset
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (error) throw error
      setMessage('Lien envoyé. Vérifie ta boîte courriel (et tes indésirables).')
      return
    } catch (err: any) {
      setMessage(err?.message ?? 'Une erreur est survenue.')
    } finally {
      setLoading(false)
    }
  }

  const title = mode === 'login' ? 'Connexion' : mode === 'signup' ? 'Créer un compte' : 'Mot de passe oublié'

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
                {title.toUpperCase()}
              </h1>

              {reason === 'auth' && (
                <div className="w-full rounded-md border border-droitis-stroke bg-white/60 px-3 py-2 text-sm">
                  Connecte-toi pour accéder à Droitis.
                </div>
              )}
              {message && (
                <div className="w-full rounded-md border border-droitis-stroke bg-white/60 px-3 py-2 text-sm">
                  {message}
                </div>
              )}
            </div>

            <form onSubmit={onSubmit} className="mt-6 space-y-5">
              <label className="block">
                <span className="droitis-label">COURRIEL</span>
                <input
                  className="droitis-input mt-2"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>

              {mode !== 'reset' && (
                <label className="block">
                  <span className="droitis-label">MOT DE PASSE</span>
                  <input
                    className="droitis-input mt-2"
                    type="password"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                </label>
              )}

              <button type="submit" disabled={loading} className="droitis-btn w-full">
                {loading
                  ? '...'
                  : mode === 'login'
                    ? 'Se connecter'
                    : mode === 'signup'
                      ? 'Créer le compte'
                      : 'Envoyer le lien'}
              </button>
            </form>

            <div className="mt-5 flex items-center justify-between text-[13px] font-semibold text-droitis-ink2">
              {standalone ? (
                <>
                  <Link className="underline underline-offset-4" href="/login">
                    Se connecter
                  </Link>
                  <div className="flex items-center gap-4">
                    {mode !== 'signup' && (
                      <Link className="underline underline-offset-4" href="/signup">
                        Créer un compte
                      </Link>
                    )}
                    {mode !== 'reset' && (
                      <Link className="underline underline-offset-4" href="/forgot-password">
                        Mot de passe oublié
                      </Link>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {mode !== 'signup' ? (
                    <button className="underline underline-offset-4" onClick={() => setMode('signup')}>
                      Créer un compte
                    </button>
                  ) : (
                    <button className="underline underline-offset-4" onClick={() => setMode('login')}>
                      Se connecter
                    </button>
                  )}

                  {mode !== 'reset' ? (
                    <button className="underline underline-offset-4" onClick={() => setMode('reset')}>
                      Mot de passe oublié
                    </button>
                  ) : (
                    <button className="underline underline-offset-4" onClick={() => setMode('login')}>
                      Retour
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </BrandBackground>
  )
}
