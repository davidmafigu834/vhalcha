import { describe, expect, it } from 'vitest';
import { encryptSecret } from '@vhalcha/security';
import type { AppDatabase } from '@vhalcha/database';
import { createRepositories } from '@vhalcha/database';
import { createTestDatabase } from '@vhalcha/database/testing';
import pino from 'pino';
import { createMetrics } from './metrics';
import { MemoryRedis } from '@vhalcha/redis';
import { listEligibleProviders, resolveProviderApiKey } from './route';
import type { GatewayDeps, PreparedChat } from './pipeline';
import { GatewayError } from '@vhalcha/types';

const secretsKey = Buffer.alloc(32, 9).toString('base64');

function deps(db: AppDatabase, keys: { openai?: string; anthropic?: string; google?: string } = {}): GatewayDeps {
  return {
    db,
    redis: new MemoryRedis(),
    openAiApiKey: keys.openai ?? '',
    platformKeys: keys,
    logger: pino({ level: 'silent' }),
    metrics: createMetrics(),
    routingRuntime: 'multi',
  };
}

function prepared(organisationId: string, environmentId: string, provider = 'openai'): PreparedChat {
  return {
    requestId: crypto.randomUUID(),
    startedAt: new Date(),
    body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] },
    organisationId,
    environmentId,
    aiSystemId: crypto.randomUUID(),
    virtualApiKeyId: crypto.randomUUID(),
    keyHash: 'hash',
    timezone: 'UTC',
    policyResult: 'allowed',
    rateLimit: { allowed: true, limit: 60, remaining: 59, resetAtEpochSeconds: 0 },
    idempotencyKey: null,
    provider,
    billableActualUsd: 0,
    billableInputTokens: 0,
    billableOutputTokens: 0,
    providerAttemptCount: 0,
  };
}

describe('provider credential consent', () => {
  it('does not treat a bare platform key as eligibility', async () => {
    const { db, client } = await createTestDatabase();
    const repos = createRepositories(db as unknown as AppDatabase);
    const org = await repos.organisations.create({ name: 'Elig', slug: `elig-${crypto.randomUUID().slice(0, 8)}` });
    const env = await repos.environments.create({ organisationId: org.id, name: 'Development', type: 'development' });
    const gateway = deps(db as unknown as AppDatabase, { openai: 'sk-live', anthropic: 'sk-ant', google: 'goog' });
    const eligible = await listEligibleProviders(gateway, prepared(org.id, env.id));
    expect(eligible).toEqual([]);
    await client.close();
  });

  it('requires explicit platform_env opt-in and a present key', async () => {
    const { db, client } = await createTestDatabase();
    const repos = createRepositories(db as unknown as AppDatabase);
    const org = await repos.organisations.create({ name: 'Plat', slug: `plat-${crypto.randomUUID().slice(0, 8)}` });
    const env = await repos.environments.create({ organisationId: org.id, name: 'Development', type: 'development' });
    await repos.providerConnections.create({
      organisationId: org.id,
      environmentId: env.id,
      provider: 'anthropic',
      name: 'Platform Anthropic',
      credentialSource: 'platform_env',
    });
    const withKey = deps(db as unknown as AppDatabase, { anthropic: 'sk-ant-live' });
    expect(await listEligibleProviders(withKey, prepared(org.id, env.id))).toEqual(['anthropic']);
    const withoutKey = deps(db as unknown as AppDatabase, {});
    expect(await listEligibleProviders(withoutKey, prepared(org.id, env.id))).toEqual([]);
    await expect(resolveProviderApiKey(withoutKey, prepared(org.id, env.id, 'anthropic'))).rejects.toBeInstanceOf(GatewayError);
    await client.close();
  });

  it('excludes failed and disabled BYOK without platform fallback', async () => {
    process.env.VHALCHA_SECRETS_KEY = secretsKey;
    const { db, client } = await createTestDatabase();
    const repos = createRepositories(db as unknown as AppDatabase);
    const org = await repos.organisations.create({ name: 'Byok', slug: `byok2-${crypto.randomUUID().slice(0, 8)}` });
    const env = await repos.environments.create({ organisationId: org.id, name: 'Development', type: 'development' });
    const gateway = deps(db as unknown as AppDatabase, { google: 'platform-google' });
    const created = await repos.providerConnections.connectOrganisation({
      organisationId: org.id,
      environmentId: env.id,
      provider: 'google',
      name: 'Org Google',
      encryptedCredentials: encryptSecret('org-google-secret', secretsKey),
    });
    await repos.providerConnections.setVerification(org.id, created.id, {
      verificationStatus: 'failed',
      verificationErrorCode: 'provider_authentication_failed',
      verifiedAt: null,
      lastCheckedAt: new Date(),
    });
    expect(await listEligibleProviders(gateway, prepared(org.id, env.id))).toEqual([]);
    await expect(resolveProviderApiKey(gateway, prepared(org.id, env.id, 'google'))).rejects.toBeInstanceOf(GatewayError);
    await repos.providerConnections.setStatus(org.id, created.id, 'disabled');
    expect(await listEligibleProviders(gateway, prepared(org.id, env.id))).toEqual([]);
    await client.close();
  });
});
