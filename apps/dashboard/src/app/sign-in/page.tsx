import Link from 'next/link';
import { SignInForm } from '../../components/forms';

export default function SignInPage() {
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <h1 className="brand-mark">Vhalcha</h1>
        <p>The AI control plane for organisations.</p>
        <SignInForm />
        <p>
          <Link href="/forgot-password">Forgot password</Link>
        </p>
        <p className="company">DIVSTAR Technologies Inc.</p>
      </section>
    </main>
  );
}
