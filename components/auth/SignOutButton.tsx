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
    <button onClick={signOut} disabled={loading} className="droitis-btn-secondary px-3 py-2 text-sm">
      {loading ? '...' : 'Se déconnecter'}
    </button>
  )
}
