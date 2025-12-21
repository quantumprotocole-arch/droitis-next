// components/auth/SignOutButton.tsx
'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../../lib/supabase/client'


export default function SignOutButton() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(false)

  async function signOut() {
    setLoading(true)
    try {
      await supabase.auth.signOut()
      router.push('/login?reason=logout')
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={signOut}
      disabled={loading}
      className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-60"
    >
      {loading ? '...' : 'Se déconnecter'}
    </button>
  )
}
