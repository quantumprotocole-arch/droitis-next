// app/login/page.tsx
'use client'

import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '../../lib/supabase/client'

type Mode = 'login' | 'signup' | 'reset'

export default function LoginPage() {
  const router = useRouter()
  const sp = useSearchParams()
  const reason = sp.get('reason')

  const supabase = useMemo(() => createClient(), [])

  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setMessage(null)

    try {
      const origin = window.location.origin

      if (mode === 'login') {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        if (signInError) throw signInError

        router.push('/app')
        router.refresh()
        return
      }

      if (mode === 'signup') {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${origin}/auth/callback?next=/app`,
          },
        })
        if (signUpError) throw signUpError

        setMessage('Compte créé. Vérifie ton email pour confirmer.')
        return
      }

      // reset
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/auth/callback?next=/reset-password`,
      })
      if (resetError) throw resetError

      setMessage('Email de réinitialisation envoyé (si le compte existe).')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur. Réessaie.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col justify-center p-6">
      <h1 className="text-2xl font-semibold">Authentification</h1>

      {reason === 'auth' && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Tu dois être connecté pour accéder à /app ou /diag.
        </p>
      )}
      {reason === 'logout' && (
        <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-900">
          Tu es déconnecté.
        </p>
      )}
      {reason === 'reset_done' && (
        <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          Mot de passe mis à jour. Tu peux te reconnecter.
        </p>
      )}

      {message && (
        <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          {message}
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <input
            className="mt-1 w-full rounded-md border px-3 py-2"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        {mode !== 'reset' && (
          <label className="block">
            <span className="text-sm font-medium">Mot de passe</span>
            <input
              className="mt-1 w-full rounded-md border px-3 py-2"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </label>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-black px-4 py-2 text-white disabled:opacity-60"
        >
          {loading
            ? '...'
            : mode === 'login'
              ? 'Se connecter'
              : mode === 'signup'
                ? 'Créer un compte'
                : 'Envoyer le lien de reset'}
        </button>
      </form>

      <div className="mt-6 flex flex-col gap-2 text-sm">
        {mode !== 'login' && (
          <button className="text-left underline" onClick={() => setMode('login')}>
            Déjà un compte ? Se connecter
          </button>
        )}
        {mode !== 'signup' && (
          <button className="text-left underline" onClick={() => setMode('signup')}>
            Créer un compte
          </button>
        )}
        {mode !== 'reset' && (
          <button className="text-left underline" onClick={() => setMode('reset')}>
            Mot de passe oublié
          </button>
        )}
      </div>
    </div>
  )
}
