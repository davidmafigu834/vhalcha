import { ResetPasswordForm } from '../../components/forms';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token ?? '';
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <h1 className="brand-mark">Choose a new password</h1>
        {token ? <ResetPasswordForm token={token} /> : <p className="error">This reset link is incomplete.</p>}
      </section>
    </main>
  );
}
