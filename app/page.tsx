// app/page.tsx
import { redirect } from 'next/navigation'
import { createClient } from '../lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function RootPage() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Si connecté -> app privée
  if (user) redirect('/app')

  // Sinon -> login
  redirect('/login')
}
