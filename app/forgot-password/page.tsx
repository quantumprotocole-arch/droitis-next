// app/forgot-password/page.tsx
import LoginForm from "../login/LoginForm";

export default function ForgotPasswordPage() {
  return <LoginForm reason={null} initialMode="reset" standalone />;
}
