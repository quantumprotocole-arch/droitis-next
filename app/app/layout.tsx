// app/app/layout.tsx
export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'
import SignOutButton from '../../components/auth/SignOutButton'


export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login?reason=auth')
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <Link href="/app" className="font-semibold">
          Droitis
        </Link>

        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-gray-600 sm:inline">{user.email}</span>
          <SignOutButton />
        </div>
      </header>

      <main className="p-4">{children}</main>
    </div>
  )
}
