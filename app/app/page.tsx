// app/page.tsx (Server Component)
import { Suspense } from 'react'
import LandingClient from '../LandingClient'

export default function HomePage() {
  return (
    <Suspense fallback={<div className="p-6">Chargement…</div>}>
      <LandingClient />
    </Suspense>
  )
}
