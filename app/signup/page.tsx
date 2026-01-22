// app/signup/page.tsx
import LoginForm from "../login/LoginForm";

export default function SignupPage() {
  return <LoginForm reason={null} initialMode="signup" standalone />;
}