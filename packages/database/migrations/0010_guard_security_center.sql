-- Security Center workflow. Threats reference Guard events. Incidents are opened by people.
-- Automated retention is not implemented. policy create_incident remains unexecuted by the gateway.

alter table guard_incidents add column description text not null default '';
alter table guard_incidents add column created_by uuid references users (id);
alter table guard_incidents add column resolved_at timestamptz;
alter table guard_incidents add column resolution text;
alter table guard_incidents add column follow_up text;
alter table guard_incidents add column display_number integer;

with numbered as (
  select id, row_number() over (partition by organisation_id order by created_at, id) as n
  from guard_incidents
)
update guard_incidents as incident
set display_number = numbered.n
from numbered
where incident.id = numbered.id;

alter table guard_incidents alter column display_number set not null;

create unique index guard_incidents_org_number_uidx on guard_incidents (organisation_id, display_number);
create index guard_incidents_org_owner_idx on guard_incidents (organisation_id, owner_user_id);
create index guard_incidents_org_updated_idx on guard_incidents (organisation_id, updated_at desc);

create table guard_display_sequences (
  organisation_id uuid not null references organisations (id),
  kind text not null check (kind in ('threat', 'incident')),
  last_value integer not null,
  primary key (organisation_id, kind)
);

insert into guard_display_sequences (organisation_id, kind, last_value)
select organisation_id, 'incident', max(display_number)
from guard_incidents
group by organisation_id;

create table guard_threats (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  display_number integer not null,
  type text not null check (type in (
    'sensitive_data_exposure',
    'secret_exposure',
    'policy_violation',
    'unapproved_provider',
    'unapproved_model',
    'runtime_enforcement_failure',
    'suspicious_tool_action',
    'prompt_risk',
    'other'
  )),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  status text not null check (status in ('open', 'investigating', 'contained', 'resolved', 'dismissed', 'expected')),
  title text not null,
  primary_event_id uuid not null references guard_events (id),
  decision_id text,
  ai_system_id uuid references ai_systems (id),
  system_name text,
  environment_id uuid references environments (id),
  environment_label text,
  provider text,
  model text,
  policy_id uuid,
  policy_name text,
  policy_version integer,
  request_id uuid references requests (id) on delete set null,
  trace_id text,
  classification text not null default '',
  outcome text not null default '',
  redaction_summary text not null default '',
  fingerprint text not null,
  occurrence_count integer not null default 1,
  fail_closed_count integer not null default 0,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  assigned_to uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, display_number)
);

create index guard_threats_org_status_seen_idx on guard_threats (organisation_id, status, last_seen_at desc);
create index guard_threats_org_fingerprint_idx on guard_threats (organisation_id, fingerprint, last_seen_at desc);
create index guard_threats_org_system_idx on guard_threats (organisation_id, ai_system_id);

create table guard_threat_events (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  threat_id uuid not null references guard_threats (id),
  event_id uuid not null references guard_events (id),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organisation_id, event_id)
);

create index guard_threat_events_threat_idx on guard_threat_events (organisation_id, threat_id, occurred_at desc);

create table guard_threat_activity (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  threat_id uuid not null references guard_threats (id),
  kind text not null check (kind in ('status', 'assignment')),
  summary text not null,
  actor_user_id uuid references users (id),
  created_at timestamptz not null default now()
);

create index guard_threat_activity_threat_idx on guard_threat_activity (organisation_id, threat_id, created_at);

create table guard_incident_threats (
  organisation_id uuid not null references organisations (id),
  incident_id uuid not null references guard_incidents (id),
  threat_id uuid not null references guard_threats (id),
  created_at timestamptz not null default now(),
  primary key (incident_id, threat_id)
);

create index guard_incident_threats_org_idx on guard_incident_threats (organisation_id, incident_id);

create table guard_incident_events (
  organisation_id uuid not null references organisations (id),
  incident_id uuid not null references guard_incidents (id),
  event_id uuid not null references guard_events (id),
  created_at timestamptz not null default now(),
  primary key (incident_id, event_id)
);

create index guard_incident_events_org_idx on guard_incident_events (organisation_id, incident_id);

create table guard_incident_notes (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  incident_id uuid not null references guard_incidents (id),
  author_user_id uuid not null references users (id),
  body text not null,
  created_at timestamptz not null default now()
);

create index guard_incident_notes_incident_idx on guard_incident_notes (organisation_id, incident_id, created_at);

create table guard_incident_timeline (
  id uuid primary key,
  organisation_id uuid not null references organisations (id),
  incident_id uuid not null references guard_incidents (id),
  kind text not null check (kind in (
    'created',
    'threat_attached',
    'event_attached',
    'owner_changed',
    'status_changed',
    'note_added',
    'resolved'
  )),
  summary text not null,
  actor_user_id uuid references users (id),
  created_at timestamptz not null default now()
);

create index guard_incident_timeline_incident_idx on guard_incident_timeline (organisation_id, incident_id, created_at);

grant select, insert, update, delete on
  guard_display_sequences,
  guard_threats,
  guard_threat_events,
  guard_threat_activity,
  guard_incident_threats,
  guard_incident_events,
  guard_incident_notes,
  guard_incident_timeline
to vhalcha_app, vhalcha_worker;

alter table guard_display_sequences enable row level security;
alter table guard_display_sequences force row level security;
drop policy if exists tenant_isolation on guard_display_sequences;
create policy tenant_isolation on guard_display_sequences
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_threats enable row level security;
alter table guard_threats force row level security;
drop policy if exists tenant_isolation on guard_threats;
create policy tenant_isolation on guard_threats
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_threat_events enable row level security;
alter table guard_threat_events force row level security;
drop policy if exists tenant_isolation on guard_threat_events;
create policy tenant_isolation on guard_threat_events
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_threat_activity enable row level security;
alter table guard_threat_activity force row level security;
drop policy if exists tenant_isolation on guard_threat_activity;
create policy tenant_isolation on guard_threat_activity
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_incident_threats enable row level security;
alter table guard_incident_threats force row level security;
drop policy if exists tenant_isolation on guard_incident_threats;
create policy tenant_isolation on guard_incident_threats
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_incident_events enable row level security;
alter table guard_incident_events force row level security;
drop policy if exists tenant_isolation on guard_incident_events;
create policy tenant_isolation on guard_incident_events
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_incident_notes enable row level security;
alter table guard_incident_notes force row level security;
drop policy if exists tenant_isolation on guard_incident_notes;
create policy tenant_isolation on guard_incident_notes
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));

alter table guard_incident_timeline enable row level security;
alter table guard_incident_timeline force row level security;
drop policy if exists tenant_isolation on guard_incident_timeline;
create policy tenant_isolation on guard_incident_timeline
  using (app.tenant_visible(organisation_id))
  with check (app.tenant_visible(organisation_id));
