import { describe, expect, it } from 'vitest';
import { encryptSecret } from '@vhalcha/security';
import type { AppDatabase } from './client';
import { createRepositories } from './repositories';
import { createTestDatabase } from './testing/harness';

const secretsKey = Buffer.alloc(32, 7).toString('base64');

describe('multi-provider connection constraints', () => {
  it('inserts openai, anthropic and google connections and rejects invalid providers', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const org = await repos.organisations.create({ name: 'Conn Org', slug: `conn-${crypto.randomUUID().slice(0, 8)}` });
    const env = await repos.environments.create({ organisationId: org.id, name: 'Development', type: 'development' });
    for (const provider of ['openai', 'anthropic', 'google'] as const) {
      const row = await repos.providerConnections.create({
        organisationId: org.id,
        environmentId: env.id,
        provider,
        name: `${provider} platform`,
        credentialSource: 'platform_env',
      });
      expect(row.provider).toBe(provider);
    }
    await expect(
      repos.providerConnections.create({
        organisationId: org.id,
        environmentId: env.id,
        provider: 'totally_fake_vendor',
        name: 'bad',
        credentialSource: 'platform_env',
      }),
    ).rejects.toThrow();
    await client.close();
  });

  it('stores BYOK for each provider without returning ciphertext on list', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const org = await repos.organisations.create({ name: 'Byok Org', slug: `byok-${crypto.randomUUID().slice(0, 8)}` });
    const env = await repos.environments.create({ organisationId: org.id, name: 'Development', type: 'development' });
    process.env.VHALCHA_SECRETS_KEY = secretsKey;
    for (const provider of ['openai', 'anthropic', 'google'] as const) {
      await repos.providerConnections.connectOrganisation({
        organisationId: org.id,
        environmentId: env.id,
        provider,
        name: `${provider} byok`,
        encryptedCredentials: encryptSecret(`fake-${provider}-secret`, secretsKey),
      });
    }
    const listed = await repos.providerConnections.list(org.id);
    expect(listed).toHaveLength(3);
    expect(listed.every((row) => !('encryptedCredentials' in row))).toBe(true);
    const active = await repos.providerConnections.findActive(org.id, env.id, 'anthropic');
    expect(active?.encryptedCredentials).toBeTruthy();
    await repos.providerConnections.setStatus(org.id, active!.id, 'disabled');
    expect(await repos.providerConnections.findActive(org.id, env.id, 'anthropic')).toBeNull();
    await client.close();
  });

  it('inserts model access rules for anthropic and google and rejects invalid vendors', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const org = await repos.organisations.create({ name: 'Rule Org', slug: `rule-${crypto.randomUUID().slice(0, 8)}` });
    const env = await repos.environments.create({ organisationId: org.id, name: 'Development', type: 'development' });
    const registered = await repos.registerAiSystem({
      organisationId: org.id,
      environmentId: env.id,
      name: 'Rules',
      description: '',
      type: 'assistant',
      riskLevel: 'low',
      monthlyBudgetUsd: 10,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: false,
    });
    for (const provider of ['openai', 'anthropic', 'google', 'mock'] as const) {
      const rule = await repos.modelAccess.create({
        organisationId: org.id,
        aiSystemId: registered.system.id,
        provider,
        modelPattern: `${provider}-*`,
        isAllowed: false,
        priority: 10,
      });
      expect(rule.provider).toBe(provider);
    }
    await expect(
      repos.modelAccess.create({
        organisationId: org.id,
        aiSystemId: registered.system.id,
        provider: 'totally_fake_vendor',
        modelPattern: '*',
        isAllowed: false,
        priority: 1,
      }),
    ).rejects.toThrow();
    await client.close();
  });

  it('keeps provider connections tenant isolated', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const orgA = await repos.organisations.create({ name: 'A', slug: `a-${crypto.randomUUID().slice(0, 8)}` });
    const orgB = await repos.organisations.create({ name: 'B', slug: `b-${crypto.randomUUID().slice(0, 8)}` });
    const envA = await repos.environments.create({ organisationId: orgA.id, name: 'Development', type: 'development' });
    await repos.environments.create({ organisationId: orgB.id, name: 'Development', type: 'development' });
    await repos.providerConnections.create({
      organisationId: orgA.id,
      environmentId: envA.id,
      provider: 'anthropic',
      name: 'A Anthropic',
      credentialSource: 'platform_env',
    });
    const fromB = await repos.providerConnections.list(orgB.id);
    expect(fromB).toHaveLength(0);
    expect(await repos.providerConnections.findActive(orgB.id, envA.id, 'anthropic')).toBeNull();
    await client.close();
  });
});
