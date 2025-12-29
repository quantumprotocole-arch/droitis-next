// app/app/page.tsx
import { createClient } from '@/lib/supabase/server'
import AppClient from './AppClient'

export const dynamic = 'force-dynamic'

const ACTIVE_STATUSES = new Set(['active', 'trialing'])

export default async function AppPage() {
  const supabase = createClient()

  // getUser() côté serveur = fiable (requête auth) :contentReference[oaicite:4]{index=4}
  const { data: { user }, error: userErr } = await supabase.auth.getUser()
  if (userErr || !user) {
    // Normalement ton guard Phase 2 redirige déjà, donc ici on ne “répare” pas.
    return null
  }

  // RLS: SELECT only own row
  const { data, error } = await supabase
    .from('subscriptions')
    .select('status')
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) {
    // On reste soft: pas d’écran blanc
    return <AppClient isActive={false} status={null} />
  }

  const status = data?.status ?? null
  const isActive = status ? ACTIVE_STATUSES.has(status) : false

  return <AppClient isActive={isActive} status={status} />
}
