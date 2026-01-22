// app/login/page.tsx (Server Component)
import LoginForm from "./LoginForm"

export default function LoginPage({ searchParams }: { searchParams?: { reason?: string } }) {
  return <LoginForm reason={searchParams?.reason ?? null} />
}
