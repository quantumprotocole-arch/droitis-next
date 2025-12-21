// app/reset-password/page.tsx
'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../../lib/supabase/client'

export default function ResetPasswordPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) throw updateError

      router.push('/login?reason=reset_done')
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur. Réessaie.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col justify-center p-6">
      <h1 className="text-2xl font-semibold">Nouveau mot de passe</h1>

      {error && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Nouveau mot de passe</span>
          <input
            className="mt-1 w-full rounded-md border px-3 py-2"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-black px-4 py-2 text-white disabled:opacity-60"
        >
          {loading ? '...' : 'Mettre à jour'}
        </button>
      </form>
    </div>
  )
}
