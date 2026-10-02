import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  guardActionLabels,
  guardEventTypeLabels,
  guardRuntimeLabels,
  guardStatusLabels,
  type GuardActionTaken,
  type GuardEventType,
  type GuardMode,
  type GuardRuntime,
  type GuardStatus,
} from '@vhalcha/guard';
import type { GuardEventRecord } from '@vhalcha/database';
import { when } from '../lib/format';

export function ModeBadge({ mode }: { mode: GuardMode }) {
  return <span className={mode === 'protect' ? 'mode-badge mode-badge-protect' : 'mode-badge'}>{mode.toUpperCase()}</span>;
}

export function SeverityMark({ severity }: { severity: string }) {
  return <span className={`severity severity-${severity}`}>{severity.toUpperCase()}</span>;
}

export function StatusText({ status }: { status: GuardStatus }) {
  return <span className={`risk risk-${status === 'unprotected' || status === 'unknown' ? 'high' : status === 'monitored' ? 'medium' : 'low'}`}>{guardStatusLabels[status]}</span>;
}

export function clock(value: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(value);
}

export function eventLabel(type: string) {
  return type in guardEventTypeLabels ? guardEventTypeLabels[type as GuardEventType] : type;
}

export function actionLabel(action: string) {
  return action in guardActionLabels ? guardActionLabels[action as GuardActionTaken] : action;
}

export function runtimeLabel(runtime: string) {
  return runtime in guardRuntimeLabels ? guardRuntimeLabels[runtime as GuardRuntime] : runtime;
}

export function GuardPage({
  title,
  lead,
  actions,
  children,
}: {
  title: string;
  lead?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="guard-layout">
      <div className="guard-head">
        <div>
          <h1 className="page-title">{title}</h1>
          {lead ? <p className="page-lead muted">{lead}</p> : null}
        </div>
        {actions ? <div className="guard-head-actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function EventRows({
  events,
  hrefFor,
}: {
  events: GuardEventRecord[];
  hrefFor: (eventId: string) => string;
}) {
  if (events.length === 0) {
    return (
      <p className="empty">
        No security events recorded for this view. Guard only lists events written by inspection or an operator action.
      </p>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Severity</th>
            <th>Event</th>
            <th>AI system</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td className="mono">{clock(event.occurredAt)}</td>
              <td>
                <SeverityMark severity={event.severity} />
              </td>
              <td>
                <Link href={hrefFor(event.id)}>{event.title}</Link>
                <div className="muted">{eventLabel(event.eventType)}</div>
              </td>
              <td>{event.systemName ?? 'Unknown system'}</td>
              <td>{actionLabel(event.actionTaken)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EventDrawer({
  event,
  closeHref,
  canMarkExpected,
  markAction,
  returnTo,
  threat,
  incident,
  canManage,
  createIncident,
}: {
  event: GuardEventRecord;
  closeHref: string;
  canMarkExpected: boolean;
  markAction: (formData: FormData) => Promise<void>;
  returnTo: string;
  threat?: { id: string; label: string } | null;
  incident?: { id: string; label: string } | null;
  canManage?: boolean;
  createIncident?: (formData: FormData) => Promise<void>;
}) {
  const evidence = Object.entries(event.evidence);
  return (
    <aside className="drawer" aria-label="Event inspector">
      <div className="row-actions">
        <h2>Event</h2>
        <Link href={closeHref}>Close</Link>
      </div>
      <p>
        <SeverityMark severity={event.severity} />
      </p>
      <dl>
        <dt>Timestamp</dt>
        <dd className="mono">{when(event.occurredAt)} UTC</dd>
        <dt>AI system</dt>
        <dd>{event.systemName ?? 'Not linked to a registered system'}</dd>
        <dt>User or service</dt>
        <dd>{event.actorLabel ?? 'Not recorded'}</dd>
        <dt>Provider</dt>
        <dd>{event.provider ?? '—'}</dd>
        <dt>Model</dt>
        <dd>{event.model ?? '—'}</dd>
        <dt>Policy triggered</dt>
        <dd>{event.policyName ?? 'No Guard policy was attached'}</dd>
        <dt>Action taken</dt>
        <dd>{actionLabel(event.actionTaken)}</dd>
        <dt>Runtime</dt>
        <dd>{event.runtime ? runtimeLabel(event.runtime) : '—'}</dd>
        <dt>Request ID</dt>
        <dd className="mono">{event.requestId ?? '—'}</dd>
        <dt>Trace ID</dt>
        <dd className="mono">{event.traceId ?? '—'}</dd>
      </dl>
      <h3>Detection</h3>
      <p>{event.description || 'Guard recorded this event without a detection narrative.'}</p>
      <h3>Enforcement</h3>
      <p>
        Action: {actionLabel(event.actionTaken)}. Status: {event.status}.
      </p>
      <h3>Evidence</h3>
      {evidence.length === 0 ? (
        <p className="muted">No sanitised evidence was stored.</p>
      ) : (
        <ul>
          {evidence.map(([key, value]) => (
            <li key={key}>
              <span className="mono">{key}</span>: {String(value)}
            </li>
          ))}
        </ul>
      )}
      {event.policyId ? (
        <p className="mono">
          Policy {event.policyId}
          {event.policyVersion ? ` · version ${event.policyVersion}` : ''}
        </p>
      ) : (
        <p className="muted">View policy is unavailable because this event has no policy version.</p>
      )}
      <p className="muted">Sensitive evidence is intentionally masked.</p>
      {threat ? <p><Link href={`/guard/threats/${threat.id}`}>View threat {threat.label}</Link></p> : null}
      {incident ? <p><Link href={`/guard/incidents/${incident.id}`}>View incident {incident.label}</Link></p> : null}
      {event.decisionId ? <p><Link href={`/guard/policies/decisions/${event.decisionId}`}>View decision</Link></p> : null}
      {event.policyId ? <p><Link href={`/guard/policies/${event.policyId}`}>View policy</Link></p> : null}
      {canManage && createIncident ? (
        <form action={createIncident}>
          <input type="hidden" name="eventId" value={event.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="severity" value={event.severity === 'info' ? 'low' : event.severity} />
          <label>
            Incident title
            <input name="title" defaultValue={event.title} required minLength={3} />
          </label>
          <button type="submit">Create incident</button>
        </form>
      ) : null}
      {canMarkExpected && event.status !== 'expected' ? (
        <form action={markAction}>
          <input type="hidden" name="eventId" value={event.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button type="submit">Mark expected</button>
        </form>
      ) : null}
      {event.status === 'expected' ? <p>Marked expected.</p> : null}
    </aside>
  );
}
