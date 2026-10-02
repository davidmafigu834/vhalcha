export function HealthStatus({ state }: { state: 'Healthy' | 'Attention' | 'Degraded' | 'Offline' }) {
  return (
    <span className={`health health-${state.toLowerCase()}`}>
      <span aria-hidden="true">●</span> {state}
    </span>
  );
}

export function PolicyStatus({ result }: { result: string }) {
  if (result === 'allowed' || result === 'Within policy') {
    return <span className="policy policy-within">✓ {result === 'allowed' ? 'Within policy' : result}</span>;
  }
  if (result === 'warning' || result === 'Warning') {
    return <span className="policy policy-warning">! Warning</span>;
  }
  if (result === 'Review required') {
    return <span className="policy policy-review">! Review required</span>;
  }
  if (result === 'blocked') {
    return <span className="policy policy-blocked">× Blocked</span>;
  }
  return <span className="policy">{result}</span>;
}

export function RiskBadge({ level }: { level: string }) {
  return <span className={`risk risk-${level}`}>{level.toUpperCase()}</span>;
}

export function KeyReveal({ rawKey, continueHref }: { rawKey: string; continueHref: string }) {
  return (
    <section className="panel">
      <h2>Copy this key now.</h2>
      <p>For security, Vhalcha will not display it again.</p>
      <p className="technical">{rawKey}</p>
      <a className="button" href={continueHref}>
        Continue
      </a>
    </section>
  );
}
