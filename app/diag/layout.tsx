// app/diag/layout.tsx
import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'

export default async function DiagLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?reason=auth')
  }

  return <>{children}</>
}
