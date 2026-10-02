import { describe, expect, it } from 'vitest';
import { requireOrganisationId, TenantScopeError } from './tenant';
import { createTestDatabase } from './testing/harness';

describe('organisation scope', () => {
  it('rejects an empty organisation id', () => {
    expect(() => requireOrganisationId('   ')).toThrow(TenantScopeError);
  });
});

describe('schema', () => {
  it('creates the control-plane tables and rejects invalid organisation state', async () => {
    const { client } = await createTestDatabase();
    const tables = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = tables.rows.map((row) => row.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'organisations',
        'users',
        'environments',
        'ai_systems',
        'virtual_api_keys',
        'provider_connections',
        'model_access_rules',
        'budgets',
        'requests',
        'usage_events',
        'audit_events',
        'policy_events',
        'guard_settings',
        'guard_system_profiles',
        'guard_events',
        'guard_incidents',
        'guard_policies',
        'guard_policy_versions',
        'guard_decisions',
        'guard_threats',
        'guard_threat_events',
        'guard_incident_threats',
        'guard_incident_events',
        'guard_incident_notes',
        'guard_incident_timeline',
      ]),
    );

    await client.query(
      `insert into organisations (id, name, slug, status) values ($1, $2, $3, $4)`,
      ['00000000-0000-0000-0000-000000000001', 'Acme Corporation', 'acme', 'active'],
    );

    await expect(
      client.query(
        `insert into organisations (id, name, slug, status) values ($1, $2, $3, $4)`,
        ['00000000-0000-0000-0000-000000000002', 'Other', 'other', 'archived'],
      ),
    ).rejects.toThrow();

    await expect(
      client.query(`update organisations set content_logging_mode = 'full_prompt' where slug = 'acme'`),
    ).rejects.toThrow();

    await client.close();
  });
});
