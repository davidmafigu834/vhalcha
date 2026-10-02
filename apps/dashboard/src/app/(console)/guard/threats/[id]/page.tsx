import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasPermission } from '@vhalcha/auth';
import { getGuardRequestActivity, getGuardThreat, listGuardOrganisationUsers } from '@vhalcha/database';
import { guardClassificationLabel, guardThreatStatuses } from '@vhalcha/guard';
import { AccessDenied } from '../../../../../components/access-denied';
import { GuardPage, SeverityMark } from '../../../../../components/guard-ui';
import { when } from '../../../../../lib/format';
import { assignGuardThreatAction, createGuardIncidentAction, updateGuardThreatAction } from '../../../../../server/guard-actions';
import { getServices, requirePageAccess } from '../../../../../server/services';

export const metadata = { title: 'Threat' };

export default async function ThreatDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const access = await requirePageAccess('guard:view');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const { id } = await params;
  const notice = (await searchParams).notice;
  const detail = await getGuardThreat(getServices().db, access.claims.oid, id);
  if (!detail) notFound();
  const canManage = hasPermission(access.role, 'guard:incident:manage');
  const users = canManage ? await listGuardOrganisationUsers(getServices().db, access.claims.oid) : [];
  const activity = detail.threat.requestId
    ? await getGuardRequestActivity(getServices().db, access.claims.oid, detail.threat.requestId)
    : { events: [], decisions: [] };
  const threat = detail.threat;
  return (
    <GuardPage title={threat.title} lead={`${detail.label}. Sensitive evidence is intentionally masked.`}>
      {notice && notice !== 'saved' ? <p className="error">{notice}</p> : null}
      <p>
        <SeverityMark severity={threat.severity} /> {threat.status}
      </p>
      <section className="panel">
        <dl>
          <dt>Threat ID</dt><dd className="mono">{detail.label}</dd>
          <dt>First detected</dt><dd className="mono">{when(threat.firstSeenAt)} UTC</dd>
          <dt>Last detected</dt><dd className="mono">{when(threat.lastSeenAt)} UTC</dd>
          <dt>Occurrences</dt><dd>{threat.occurrenceCount}</dd>
          <dt>AI system</dt><dd>{threat.aiSystemId ? <Link href={`/guard/inventory/${threat.aiSystemId}`}>{threat.systemName}</Link> : 'Unknown system'}</dd>
          <dt>Environment</dt><dd>{threat.environmentLabel ?? '—'}</dd>
          <dt>Provider</dt><dd>{threat.provider ?? '—'}</dd>
          <dt>Model</dt><dd>{threat.model ?? '—'}</dd>
          <dt>Policy</dt><dd>{threat.policyId ? <Link href={`/guard/policies/${threat.policyId}`}>{threat.policyName} v{threat.policyVersion ?? '—'}</Link> : 'No policy was attached'}</dd>
          <dt>Runtime</dt><dd>Vhalcha Gateway</dd>
          <dt>Latest request</dt><dd className="mono">{threat.requestId ?? '—'}</dd>
          <dt>Trace ID</dt><dd className="mono">{threat.traceId ?? '—'}</dd>
        </dl>
      </section>
      <section className="panel">
        <h2>What happened</h2>
        <p>{detail.explanation.happened}</p>
        <h2>What Guard did</h2>
        <p>{detail.explanation.action}</p>
      </section>
      <section className="panel">
        <h2>Detected classifications</h2>
        {threat.classification ? (
          <ul>
            {threat.classification.split(',').filter(Boolean).map((item) => (
              <li key={item}>{guardClassificationLabel(item)}</li>
            ))}
          </ul>
        ) : (
          <p>No classification was stored.</p>
        )}
        {threat.redactionSummary ? <p>Redaction counts: {threat.redactionSummary}</p> : null}
        <p className="muted">Sensitive evidence is intentionally masked.</p>
      </section>
      <section className="panel">
        <h2>Occurrences</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Time</th><th>Request ID</th><th>Provider</th><th>Model</th><th>Action</th><th>Outcome</th></tr>
            </thead>
            <tbody>
              {detail.occurrences.map((occurrence) => (
                <tr key={occurrence.eventId}>
                  <td className="mono">{when(occurrence.occurredAt)}</td>
                  <td className="mono">{occurrence.requestId ?? '—'}</td>
                  <td>{occurrence.provider ?? '—'}</td>
                  <td>{occurrence.model ?? '—'}</td>
                  <td>{occurrence.actionTaken}</td>
                  <td>
                    <Link href={`/guard?event=${occurrence.eventId}`}>{(occurrence.outcome || 'recorded').replaceAll('_', ' ').toUpperCase()}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Related activity</h2>
        <p>{detail.relatedEvents} similar events for this system and classification in the 24 hours before the latest occurrence.</p>
        <p className="muted">This is a count of matching stored events. It does not infer a cause.</p>
      </section>
      <section className="panel">
        <h2>Timeline</h2>
        <ul>
          <li>{when(threat.firstSeenAt)} UTC — Threat detected</li>
          {detail.activity.map((entry) => (
            <li key={entry.id}>{when(entry.createdAt)} UTC — {entry.summary}</li>
          ))}
        </ul>
      </section>
      {threat.requestId ? (
        <section className="panel">
          <h2>Guard request timeline</h2>
          <p className="muted">Structured request telemetry for this request id. This is not a distributed trace.</p>
          <ul>
            {activity.events.map((event) => (
              <li key={event.id}>{when(event.occurredAt)} UTC — {event.title}{event.outcome ? ` · ${event.outcome}` : ''}</li>
            ))}
            {activity.decisions.map((decision) => (
              <li key={decision.id}>
                {when(decision.evaluatedAt)} UTC — Decision {decision.decision}. Considered {decision.policiesConsidered}. Matched {decision.policiesMatched}. Outcome {decision.outcome || 'recorded'}.
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {canManage ? (
        <section className="panel">
          <h2>Investigation</h2>
          <form action={updateGuardThreatAction} className="filters">
            <input type="hidden" name="threatId" value={threat.id} />
            <label>Status<select name="status" defaultValue={threat.status}>{guardThreatStatuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label>Reason<input name="reason" placeholder="Required to dismiss or mark expected" /></label>
            <button type="submit">Update status</button>
          </form>
          <p className="muted">Expected means this activity is legitimate and known. Dismissed means it was reviewed and needs no further action. Neither change modifies Guard policy.</p>
          <form action={assignGuardThreatAction} className="filters">
            <input type="hidden" name="threatId" value={threat.id} />
            <label>Owner<select name="assigneeUserId" defaultValue={threat.assignedTo ?? ''}><option value="">Unassigned</option>{users.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
            <button className="secondary" type="submit">Assign</button>
          </form>
          <form action={createGuardIncidentAction}>
            <input type="hidden" name="threatId" value={threat.id} />
            <input type="hidden" name="severity" value={threat.severity} />
            <input type="hidden" name="returnTo" value={`/guard/threats/${threat.id}`} />
            <label>Incident title<input name="title" defaultValue={threat.title} required minLength={3} /></label>
            <label>Description<textarea name="description" rows={3} defaultValue={`${detail.label} requires investigation.`} /></label>
            <button type="submit">Create incident</button>
          </form>
        </section>
      ) : (
        <p className="muted">Incident management requires the security incident permission.</p>
      )}
      {detail.incidents.length > 0 ? (
        <section className="panel">
          <h2>Incidents</h2>
          <ul>
            {detail.incidents.map((incident) => (
              <li key={incident.id}><Link href={`/guard/incidents/${incident.id}`}>INC-{String(incident.displayNumber).padStart(6, '0')}</Link> · {incident.status}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </GuardPage>
  );
}
