import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasPermission } from '@vhalcha/auth';
import { getGuardIncident, listGuardOrganisationUsers } from '@vhalcha/database';
import { formatGuardSequence } from '@vhalcha/guard';
import { AccessDenied } from '../../../../../components/access-denied';
import { GuardPage, SeverityMark } from '../../../../../components/guard-ui';
import { when } from '../../../../../lib/format';
import { addGuardIncidentNoteAction, assignGuardIncidentAction, updateGuardIncidentAction } from '../../../../../server/guard-actions';
import { getServices, requirePageAccess } from '../../../../../server/services';

export const metadata = { title: 'Incident' };

const statuses = ['open', 'investigating', 'contained', 'resolved', 'dismissed'];

export default async function IncidentDetailPage({
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
  const detail = await getGuardIncident(getServices().db, access.claims.oid, id);
  if (!detail) notFound();
  const canManage = hasPermission(access.role, 'guard:incident:manage');
  const users = canManage ? await listGuardOrganisationUsers(getServices().db, access.claims.oid) : [];
  const incident = detail.incident;
  return (
    <GuardPage title={detail.label} lead={incident.title}>
      {notice && notice !== 'saved' ? <p className="error">{notice}</p> : null}
      <p><SeverityMark severity={incident.severity} /> {incident.status}</p>
      <section className="panel">
        <h2>Overview</h2>
        <dl>
          <dt>Severity</dt><dd>{incident.severity.toUpperCase()}</dd>
          <dt>Status</dt><dd>{incident.status}</dd>
          <dt>Owner</dt><dd>{detail.ownerName}</dd>
          <dt>Created</dt><dd className="mono">{when(incident.createdAt)} UTC</dd>
          <dt>Last updated</dt><dd className="mono">{when(incident.updatedAt)} UTC</dd>
          <dt>Affected systems</dt><dd>{detail.systems.join(', ') || '—'}</dd>
          <dt>Related threats</dt><dd>{detail.threats.length}</dd>
          <dt>Related events</dt><dd>{detail.events.length}</dd>
        </dl>
        {detail.summary.events > 0 ? (
          <p>
            {detail.summary.events} related Guard events
            {detail.summary.first && detail.summary.last ? ` were identified between ${when(detail.summary.first)} and ${when(detail.summary.last)} UTC` : ''}.{' '}
            {detail.summary.redacted} were redacted. {detail.summary.observed} occurred without modifying the request.
          </p>
        ) : (
          <p>No Guard events are attached yet.</p>
        )}
        {incident.description ? <p>{incident.description}</p> : null}
      </section>
      <section className="panel">
        <h2>Timeline</h2>
        <ul>
          {detail.timeline.map((entry) => (
            <li key={entry.id}>{when(entry.createdAt)} UTC — {entry.summary}</li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>Threats</h2>
        <ul>
          {detail.threats.map((threat) => (
            <li key={threat.id}><Link href={`/guard/threats/${threat.id}`}>{formatGuardSequence('THR', threat.displayNumber)} · {threat.title}</Link></li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>Events</h2>
        <ul>
          {detail.events.map((event) => (
            <li key={event.id}>
              <Link href={`/guard?event=${event.id}`}>{event.title}</Link>
              {' · '}{(event.outcome || event.actionTaken).replaceAll('_', ' ')}
              {event.decisionId ? <> · <Link href={`/guard/policies/decisions/${event.decisionId}`}>decision</Link></> : null}
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>Policies</h2>
        <ul>
          {detail.policies.map((policy) => (
            <li key={policy.id}><Link href={`/guard/policies/${policy.id}`}>{policy.name} v{policy.version}</Link></li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>Notes</h2>
        {detail.notes.length === 0 ? <p>No investigation notes.</p> : (
          <ul>{detail.notes.map((note) => <li key={note.id}><strong>{note.author}</strong> · {when(note.createdAt)} UTC — {note.body}</li>)}</ul>
        )}
        {canManage ? (
          <form action={addGuardIncidentNoteAction}>
            <input type="hidden" name="incidentId" value={incident.id} />
            <label>Note<textarea name="body" rows={3} required /></label>
            <button type="submit">Add note</button>
          </form>
        ) : null}
      </section>
      <section className="panel">
        <h2>Resolution</h2>
        {incident.resolution ? <p>{incident.resolution}</p> : <p>No resolution recorded.</p>}
        {incident.followUp ? <p>Follow-up: {incident.followUp}</p> : null}
        {canManage ? (
          <>
            <form action={assignGuardIncidentAction} className="filters">
              <input type="hidden" name="incidentId" value={incident.id} />
              <label>Assign<select name="assigneeUserId" defaultValue={incident.ownerUserId ?? ''}><option value="">Unassigned</option>{users.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
              <button className="secondary" type="submit">Assign</button>
            </form>
            <form action={updateGuardIncidentAction} className="filters">
              <input type="hidden" name="incidentId" value={incident.id} />
              <label>Status<select name="status" defaultValue={incident.status}>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              <label>Resolution summary<textarea name="resolution" rows={3} defaultValue={incident.resolution ?? ''} placeholder="Required to resolve or dismiss" /></label>
              <label>Follow-up<input name="followUp" defaultValue={incident.followUp ?? ''} /></label>
              <button type="submit">Change status</button>
            </form>
            <p className="muted">Resolving does not edit a Guard policy. Open the linked policy to change enforcement.</p>
          </>
        ) : (
          <p className="muted">Changing status requires the security incident permission.</p>
        )}
      </section>
    </GuardPage>
  );
}
