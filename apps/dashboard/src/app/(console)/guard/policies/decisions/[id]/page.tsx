import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getGuardDecision, getGuardSettings } from '@vhalcha/database';
import { decisionLabel, type GuardDecision } from '@vhalcha/guard';
import { AccessDenied } from '../../../../../../components/access-denied';
import { GuardPage, ModeBadge } from '../../../../../../components/guard-ui';
import { when } from '../../../../../../lib/format';
import { getServices, requirePageAccess } from '../../../../../../server/services';

export const metadata = { title: 'Guard decision' };

export default async function GuardDecisionPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const { id } = await params;
  const services = getServices();
  const stored = await getGuardDecision(services.db, access.claims.oid, id);
  if (!stored) notFound();
  const settings = await getGuardSettings(services.db, access.claims.oid);
  const matched = (stored.matchedPolicies ?? []) as GuardDecision['matchedPolicies'];
  const reasons = (stored.reasons ?? []) as string[];
  const label = decisionLabel({
    decision: stored.decision as GuardDecision['decision'],
    wouldEnforce: stored.wouldEnforceAction ? { action: stored.wouldEnforceAction as NonNullable<GuardDecision['wouldEnforce']>['action'], policyId: stored.wouldEnforcePolicyId ?? '' } : undefined,
    enforcementExecuted: false,
  });
  return (
    <GuardPage title={label} lead={`${stored.source} evaluation.`}>
      <section className="panel">
        <p>
          Organisation Guard mode <ModeBadge mode={settings.mode} />
        </p>
        <p>
          Effective mode {stored.effectiveMode}. Evaluation time {stored.evaluationMs} ms. Considered {stored.policiesConsidered}. Matched {stored.policiesMatched}.
        </p>
        <p>{when(stored.evaluatedAt)}</p>
        {stored.source === 'tester' || stored.source === 'simulation' ? (
          <p className="muted">This synthetic decision is excluded from overview security metrics.</p>
        ) : null}
      </section>
      <section className="panel">
        <h2>Matched policies</h2>
        {matched.length === 0 ? (
          <p>No Guard policy matched.</p>
        ) : (
          <ul>
            {matched.map((policy) => (
              <li key={policy.policyVersionId}>
                <Link href={`/guard/policies/${policy.policyId}`}>
                  {policy.name} v{policy.version}
                </Link>{' '}
                · priority {policy.priority} · {policy.action}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>Enforcement</h2>
        <dl>
          <dt>Decision</dt><dd>{stored.decision}</dd>
          <dt>Effective mode</dt><dd>{stored.effectiveMode}</dd>
          <dt>Requested action</dt><dd>{stored.wouldEnforceAction ?? stored.decision}</dd>
          <dt>Outcome</dt><dd>{String(stored.contextSummary?.outcome ?? 'not recorded')}</dd>
          <dt>Enforcement executed</dt><dd>{String(stored.contextSummary?.enforcementExecuted ?? 'false')}</dd>
          <dt>Redaction summary</dt><dd>{String(stored.contextSummary?.redactionSummary ?? 'none')}</dd>
          <dt>Runtime</dt><dd>Vhalcha Gateway</dd>
        </dl>
        <p className="muted">Raw request content is not stored on this decision.</p>
      </section>
      <section className="panel">
        <h2>Reason</h2>
        {reasons.map((reason) => (
          <p key={reason}>{reason}</p>
        ))}
      </section>
    </GuardPage>
  );
}
