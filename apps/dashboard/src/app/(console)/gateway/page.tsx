import Link from 'next/link';
import { createRoutingRepository, getGatewayReport, getRequestDetail } from '@vhalcha/database';
import { AccessDenied } from '../../../components/access-denied';
import { PolicyStatus } from '../../../components/status';
import { periodRange, usd, when } from '../../../lib/format';
import { getServices, requirePageAccess } from '../../../server/services';

export const metadata = { title: 'Gateway' };

function reasonRecord(reason: unknown): Record<string, unknown> | null {
  return reason && typeof reason === 'object' ? (reason as Record<string, unknown>) : null;
}

function reasonValue(reason: unknown, key: string): unknown {
  return reasonRecord(reason)?.[key] ?? null;
}

function reasonText(reason: unknown): string {
  const reasons = reasonValue(reason, 'reasons');
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return '—';
  }
  return reasons.filter((item) => typeof item === 'string').join(' ');
}

function rejectionCodes(reason: unknown): string {
  const rejected = reasonValue(reason, 'rejected');
  if (!Array.isArray(rejected) || rejected.length === 0) {
    return '—';
  }
  return rejected
    .map((item) => (item && typeof item === 'object' && 'code' in item ? String((item as { code: unknown }).code) : ''))
    .filter(Boolean)
    .join(', ') || '—';
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function requestSizeLabel(value: string): string {
  if (value === 'low') return 'small';
  if (value === 'high') return 'large';
  return value;
}

function savingsUnavailable(reason: unknown): string {
  const available = reasonValue(reason, 'savings_available');
  if (available === false) {
    return 'Unavailable — pricing data requires verification';
  }
  return 'Baseline not configured';
}

export default async function GatewayPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; request?: string }>;
}) {
  const access = await requirePageAccess('gateway:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const params = await searchParams;
  const range = periodRange(params.period);
  const report = await getGatewayReport(getServices().db, session.claims.oid, range.start, range.end);
  const savings = await createRoutingRepository(getServices().db).savingsSummary(session.claims.oid, range.start, range.end);
  const routing = createRoutingRepository(getServices().db);
  const decision = params.request ? await routing.findByRequest(session.claims.oid, params.request) : null;
  const attempts = params.request ? await routing.listAttempts(session.claims.oid, params.request) : [];
  const detail = params.request
    ? await getRequestDetail(getServices().db, session.claims.oid, params.request)
    : null;
  return (
    <>
      <h1 className="page-title">Gateway</h1>
      <nav className="row-actions">
        <Link href="/gateway/routing">Routing</Link>
        <Link href="/gateway/models">Models</Link>
        <Link href="/gateway/providers">Providers</Link>
      </nav>
      <section className="grid-3">
        <article className="metric"><span>Estimated baseline spend</span><strong>{savings.optimised === 0 ? '—' : usd(savings.estimatedBaseline)}</strong></article>
        <article className="metric"><span>Estimated routed spend</span><strong>{savings.optimised === 0 ? '—' : usd(savings.estimatedSelected)}</strong></article>
        <article className="metric"><span>{savings.estimatedSavings < 0 ? 'Estimated additional cost' : 'Estimated optimisation benefit'}</span><strong>{savings.optimised === 0 ? '—' : savings.savingsPercent === null ? 'Baseline not configured' : usd(savings.estimatedSavings)}</strong></article>
        <article className="metric"><span>Optimised routes</span><strong>{savings.optimised}</strong></article>
        <article className="metric"><span>Fallbacks</span><strong>{savings.fallbacks}</strong></article>
      </section>
      <p className="muted">Estimated optimisation benefit is calculated from model token pricing and is not the provider invoice. A negative figure is additional estimated cost, not a saving.</p>
      <nav className="row-actions">
        {['24h', '7d', '30d'].map((period) => (
          <Link key={period} href={`/gateway?period=${period}`}>
            {period}
          </Link>
        ))}
      </nav>
      <section className="grid-3">
        <article className="metric"><span>Requests</span><strong>{report.total}</strong></article>
        <article className="metric"><span>Success rate</span><strong>{report.successRate === null ? '—' : `${Math.round(report.successRate * 100)}%`}</strong></article>
        <article className="metric"><span>p50 latency</span><strong>{report.p50 === null ? '—' : `${report.p50} ms`}</strong></article>
        <article className="metric"><span>p95 latency</span><strong>{report.p95 === null ? '—' : `${report.p95} ms`}</strong></article>
        <article className="metric"><span>Error rate</span><strong>{report.errorRate === null ? '—' : `${Math.round(report.errorRate * 100)}%`}</strong></article>
        <article className="metric"><span>Actual token-priced spend</span><strong>{usd(report.spend)}</strong></article>
      </section>
      <p className="muted">Latency percentiles use the nearest-rank method on requests returned for this period, up to 200 rows.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Request ID</th>
              <th>AI System</th>
              <th>Provider</th>
              <th>Model</th>
              <th>Status</th>
              <th>Latency</th>
              <th>Tokens</th>
              <th>Actual token-priced cost</th>
              <th>Policy result</th>
            </tr>
          </thead>
          <tbody>
            {report.requests.length === 0 ? (
              <tr><td colSpan={10}>No requests in this period.</td></tr>
            ) : report.requests.map((request) => (
              <tr key={request.id}>
                <td className="mono">{when(request.createdAt)}</td>
                <td className="mono"><Link href={`/gateway?period=${range.label}&request=${request.id}`}>{request.id}</Link></td>
                <td>{request.systemName}</td>
                <td>{request.provider}</td>
                <td>{request.model}</td>
                <td>{request.status}</td>
                <td>{request.latencyMs === null ? '—' : `${request.latencyMs} ms`}</td>
                <td>{request.totalTokens ?? '—'}</td>
                <td>{usd(request.estimatedCostUsd ? Number(request.estimatedCostUsd) : null)}</td>
                <td><PolicyStatus result={request.policyResult} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {params.request ? (
        <aside className="drawer" aria-label="Request detail">
          <Link href={`/gateway?period=${range.label}`}>Close</Link>
          {!detail ? <p>Request not found in this organisation.</p> : (
            <>
              <h2>Request metadata</h2>
              <p className="mono">{detail.request.id}</p>
              <p>AI system: {detail.system?.name}</p>
              <p>Routing/provider: {detail.request.provider} / {detail.request.model}</p>
              <p>Key prefix: <span className="mono">{detail.keyPrefix ?? '—'}</span></p>
              <h2>Budget and model access</h2>
              {detail.policies.length === 0 ? <p>No separate policy event. Policy result: {detail.request.policyResult}.</p> : detail.policies.map((event) => (
                <p key={event.id}>{event.policyType}: {event.policyName} · {event.result}</p>
              ))}
              <h2>Route decision</h2>
              {!decision ? <p>No optimised routing decision for this request.</p> : (
                <>
                  <p>Strategy: {decision.routingStrategy}</p>
                  <p>Request size: {requestSizeLabel(decision.complexity)}</p>
                  <p>Selected: {decision.selectedProvider} / {decision.selectedModel}</p>
                  <p>Selection reason: {reasonText(decision.decisionReason)}</p>
                  <p>Qualifying models: {String(reasonValue(decision.decisionReason, 'qualifying_count') ?? decision.candidateCount)}</p>
                  <p>Rejection codes: {rejectionCodes(decision.decisionReason)}</p>
                  <p>Estimated route cost: {usd(decision.estimatedSelectedCost ? Number(decision.estimatedSelectedCost) : null)}</p>
                  <p>Next-cheapest estimated cost: {usd(numberOrNull(reasonValue(decision.decisionReason, 'next_cheapest_cost')))}</p>
                  <p>Estimated baseline cost: {decision.estimatedBaselineCost === null ? 'Baseline not configured' : usd(Number(decision.estimatedBaselineCost))}</p>
                  <p>{decision.estimatedSavings !== null && Number(decision.estimatedSavings) < 0 ? 'Estimated additional cost' : 'Estimated optimisation benefit'}: {decision.estimatedSavings === null ? savingsUnavailable(decision.decisionReason) : usd(Number(decision.estimatedSavings))}</p>
                  <p>Pricing verified: {String(reasonValue(decision.decisionReason, 'pricing_verified_at') ?? '—')}</p>
                  <p>Fallback from: {decision.fallbackFrom ?? '—'}</p>
                  <p>Knowledge used: {reasonValue(decision.decisionReason, 'has_knowledge_context') ? 'yes' : 'no'}</p>
                </>
              )}
              <h2>Usage and cost</h2>
              <p>Tokens: {detail.request.totalTokens ?? '—'}</p>
              <p>Actual token-priced cost: {usd(detail.request.estimatedCostUsd ? Number(detail.request.estimatedCostUsd) : null)}</p>
              <h2>Provider attempts</h2>
              {attempts.length === 0 ? <p>No provider attempts recorded.</p> : attempts.map((attempt) => (
                <p key={attempt.id}>
                  Attempt {attempt.attemptNumber}: {attempt.provider} / {attempt.model}
                  {' · '}{attempt.status}
                  {' · '}{attempt.reason}
                  {attempt.errorCode ? ` · ${attempt.errorCode}` : ''}
                  {' · '}in {attempt.inputTokens ?? '—'} / out {attempt.outputTokens ?? '—'}
                  {' · '}token-priced {usd(attempt.actualCostUsd === null ? null : Number(attempt.actualCostUsd))}
                  {' · '}{attempt.billable ? 'billable' : 'not billable'}
                  {' · '}{attempt.startedAt && attempt.completedAt
                    ? `${Math.max(0, new Date(attempt.completedAt).getTime() - new Date(attempt.startedAt).getTime())} ms`
                    : '—'}
                </p>
              ))}
              <h2>Timing</h2>
              <p>Latency: {detail.request.latencyMs ?? '—'} ms</p>
              <p>Provider latency: {detail.request.providerLatencyMs ?? '—'} ms</p>
              <p>Time to first token: {detail.request.timeToFirstTokenMs ?? '—'} ms</p>
              {detail.request.errorCode ? <p>Blocked or failed: {detail.request.errorCode}. {detail.request.errorMessageSafe}</p> : null}
              <h2>Audit events</h2>
              {detail.audits.map((event) => <p key={event.id}>{event.action} · {event.result}</p>)}
              <p className="muted">Raw prompts and responses are not stored.</p>
            </>
          )}
        </aside>
      ) : null}
    </>
  );
}
