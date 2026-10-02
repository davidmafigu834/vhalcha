import Link from 'next/link';
import { ResetRequestForm } from '../../components/forms';

export default function ForgotPasswordPage() {
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <h1 className="brand-mark">Reset access</h1>
        <p>Vhalcha does not confirm whether an email is registered.</p>
        <ResetRequestForm />
        <p>
          <Link href="/sign-in">Return to sign in</Link>
        </p>
      </section>
    </main>
  );
}
