'use client';

export default function GuardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="panel">
      <h1 className="page-title">Guard is unavailable</h1>
      <p>The security control plane could not be loaded. Retry the page. If this continues, the database or session may be unavailable.</p>
      <button type="button" onClick={() => reset()}>
        Try again
      </button>
    </section>
  );
}
