import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashPassword } from '@vhalcha/security';
import type { UserRole } from '@vhalcha/types';
import { contentHash, createMockEmbeddingProvider, MemoryKnowledgeObjectStore } from '@vhalcha/knowledge';
import { createDatabase } from './client';
import { indexKnowledgeVersion } from './knowledge-ingest';
import { createKnowledgeRepository } from './knowledge';
import { createRepositories } from './repositories';
import { listGuardInventory, markGuardOrganisationDemo, upsertGuardProfile } from './guard';
import { activateGuardPolicy, createGuardPolicy, listGuardPolicies } from './guard-policies';

export const DEV_SEED_PASSWORD = 'ChangeMe-Dev-Only-1';

const users: Array<{ email: string; name: string; role: UserRole }> = [
  { email: 'owner@acme.test', name: 'Ada Owner', role: 'owner' },
  { email: 'ai-admin@acme.test', name: 'Ben Admin', role: 'ai_admin' },
  { email: 'developer@acme.test', name: 'Casey Developer', role: 'developer' },
  { email: 'security@acme.test', name: 'Dana Security', role: 'security_admin' },
  { email: 'finance@acme.test', name: 'Evan Finance', role: 'finance_manager' },
  { email: 'viewer@acme.test', name: 'Fran Viewer', role: 'viewer' },
];

export async function seedDevelopment(connectionString: string, devModel = 'gpt-4.1-mini') {
  if (process.env.VHALCHA_ENV === 'production') {
    throw new Error('Refusing to seed a production environment.');
  }
  const { db, pool } = createDatabase(connectionString);
  try {
    const repos = createRepositories(db);
    const existing = await repos.organisations.findBySlug('acme');
    if (existing) {
      await seedDemoKnowledge(db, existing.id);
      await seedGuardDemo(db, existing.id);
      return { alreadySeeded: true as const };
    }
    const organisation = await repos.organisations.create({
      name: 'Acme Corporation',
      slug: 'acme',
      timezone: 'America/New_York',
    });
    const development = await repos.environments.create({
      organisationId: organisation.id,
      name: 'Development',
      type: 'development',
    });
    await repos.environments.create({
      organisationId: organisation.id,
      name: 'Production',
      type: 'production',
    });
    const passwordHash = await hashPassword(DEV_SEED_PASSWORD);
    let ownerId: string | null = null;
    for (const user of users) {
      const created = await repos.users.create({
        organisationId: organisation.id,
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash,
      });
      if (user.role === 'owner') {
        ownerId = created.id;
      }
    }
    await repos.providerConnections.create({
      organisationId: organisation.id,
      environmentId: development.id,
      provider: 'openai',
      name: 'OpenAI platform credential',
      credentialSource: 'platform_env',
      credentialRef: 'OPENAI_API_KEY',
    });
    const systems = [
      { name: 'Customer Support AI', riskLevel: 'medium', budget: 25, pattern: devModel, type: 'assistant' },
      { name: 'Finance Assistant', riskLevel: 'high', budget: 40, pattern: devModel, type: 'assistant' },
      { name: 'Website Assistant', riskLevel: 'low', budget: 15, pattern: 'gpt-4o-mini', type: 'assistant' },
    ];
    const keys: Array<{ system: string; keyPrefix: string; rawKey: string }> = [];
    for (const system of systems) {
      const registered = await repos.registerAiSystem({
        organisationId: organisation.id,
        environmentId: development.id,
        name: system.name,
        description: 'Development seed data. Not production traffic.',
        type: system.type,
        riskLevel: system.riskLevel,
        monthlyBudgetUsd: system.budget,
        modelPattern: system.pattern,
        requestsPerMinute: 60,
        ownerUserId: ownerId,
        generateKey: true,
        actorUserId: ownerId,
      });
      if (registered.key) {
        keys.push({
          system: system.name,
          keyPrefix: registered.key.record.keyPrefix,
          rawKey: registered.key.rawKey,
        });
      }
    }
    const directory = path.resolve(process.cwd(), '../../.local');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'seed-keys.json'),
      JSON.stringify(
        {
          warning: 'Development virtual keys. Shown once by the seed command. Do not use in production.',
          keys,
        },
        null,
        2,
      ),
      'utf8',
    );
    await seedDemoKnowledge(db, organisation.id);
    await seedGuardDemo(db, organisation.id);
    return { alreadySeeded: false as const, keys };
  } finally {
    await pool.end();
  }
}

async function seedDemoKnowledge(db: ReturnType<typeof createDatabase>['db'], organisationId: string) {
  if (process.env.VHALCHA_ENV === 'production') {
    return;
  }
  const repos = createRepositories(db);
  const knowledge = createKnowledgeRepository(db);
  const spaces = await knowledge.listSpaces(organisationId);
  if (spaces.some((space) => space.slug === 'product-support')) {
    return;
  }
  const systems = await repos.aiSystems.list(organisationId);
  const support = systems.find((system) => system.name === 'Customer Support AI');
  const space = await knowledge.createSpace({
    organisationId,
    name: 'Product & Support',
    description: 'Fictional Acme development knowledge. Not a real company policy.',
    defaultFreshnessDays: 365,
  });
  const text =
    'Fictional Acme Returns Policy. This is development seed data, not a real company policy. Customers may return unused products within 30 days. Damaged items are replaced.';
  const source = await knowledge.createSource({
    organisationId,
    knowledgeSpaceId: space.id,
    name: 'Returns Policy',
    sourceType: 'manual_text',
  });
  const created = await knowledge.createPendingDocument({
    organisationId,
    knowledgeSpaceId: space.id,
    knowledgeSourceId: source.id,
    title: 'Returns Policy',
    documentType: 'text',
    mimeType: 'text/plain',
    contentHash: contentHash(text),
    extractedText: text,
  });
  await indexKnowledgeVersion(db, {
    organisationId,
    documentVersionId: created.versionId,
    embedder: createMockEmbeddingProvider(),
    store: new MemoryKnowledgeObjectStore(),
  });
  if (support) {
    await knowledge.grantAccess({
      organisationId,
      aiSystemId: support.id,
      knowledgeSpaceId: space.id,
    });
  }
}

async function seedGuardDemo(db: ReturnType<typeof createDatabase>['db'], organisationId: string) {
  if (process.env.VHALCHA_ENV === 'production') {
    return;
  }
  await markGuardOrganisationDemo(db, organisationId);
  const repos = createRepositories(db);
  const accounts = await repos.users.list(organisationId);
  const owner = accounts.find((account) => account.role === 'owner');
  if (!owner) {
    return;
  }
  const inventory = await listGuardInventory(db, organisationId);
  for (const name of ['Customer Support AI', 'Finance Assistant']) {
    const system = inventory.systems.find((item) => item.name === name);
    if (!system || system.profileId) {
      continue;
    }
    await upsertGuardProfile(db, organisationId, {
      aiSystemId: system.id,
      actorUserId: owner.id,
      guardStatus: 'monitored',
      runtime: 'vhalcha_gateway',
      dataAccess: name === 'Customer Support AI' ? ['Product & Support'] : [],
      sensitiveDataUnrestricted: false,
      overprivileged: false,
    });
  }
  const existingPolicies = await listGuardPolicies(db, organisationId);
  const names = new Set(existingPolicies.map((policy) => policy.name));
  const support = inventory.systems.find((item) => item.name === 'Customer Support AI');
  const demos: Array<Parameters<typeof createGuardPolicy>[1]> = [
    {
      organisationId,
      actorUserId: owner.id,
      name: 'Customer PII Protection',
      description: 'Control whether personally identifiable customer information may be sent to selected AI providers.',
      category: 'data',
      mode: 'monitor',
      priority: 300,
      document: {
        scope: support ? { systemIds: [support.id] } : { organizationWide: true },
        conditions: {
          logic: 'all',
          conditions: [
            { field: 'request.detectedDataTypes', operator: 'contains', value: 'CUSTOMER_PII' },
            { field: 'provider.id', operator: 'not_in', value: ['openai'] },
          ],
        },
        actions: [{ type: 'redact', config: { dataTypes: ['CUSTOMER_PII'] } }],
      },
    },
    {
      organisationId,
      actorUserId: owner.id,
      name: 'Approved Production Models',
      description: 'Apply a recorded warning when a production request uses a model outside the approved set.',
      category: 'model',
      mode: 'monitor',
      priority: 250,
      document: {
        scope: { environments: ['production'] },
        conditions: {
          logic: 'all',
          conditions: [{ field: 'model.id', operator: 'not_in', value: ['CONFIGURE_APPROVED_MODEL'] }],
        },
        actions: [{ type: 'warn', config: { message: 'Production model is outside the approved set.' } }],
      },
    },
    {
      organisationId,
      actorUserId: owner.id,
      name: 'High-Risk Tool Approval',
      description: 'Record when an agent would need approval before using a high-risk tool.',
      category: 'tool',
      mode: 'monitor',
      priority: 350,
      document: {
        scope: { organizationWide: true },
        conditions: {
          logic: 'all',
          conditions: [{ field: 'tool.riskLevel', operator: 'equals', value: 'high' }],
        },
        actions: [{ type: 'require_approval', config: { approvalGroup: 'security-admin' } }],
      },
    },
  ];
  for (const demo of demos) {
    if (names.has(demo.name)) continue;
    const created = await createGuardPolicy(db, demo);
    await activateGuardPolicy(db, organisationId, created.policyId, owner.id);
  }
}

const executedDirectly = process.argv[1]?.includes('seed');

if (executedDirectly) {
  const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Invalid environment configuration: DATABASE_ADMIN_URL');
    process.exit(1);
  }
  seedDevelopment(connectionString, process.env.VHALCHA_DEV_MODEL || 'gpt-4.1-mini')
    .then((result) => {
      if (result.alreadySeeded) {
        console.log('Acme Corporation is already seeded.');
        return;
      }
      console.log('Seeded Acme Corporation.');
      console.log(`Development password for all seed users: ${DEV_SEED_PASSWORD}`);
      for (const key of result.keys) {
        console.log(`${key.system}: ${key.rawKey}`);
      }
      console.log('Copy these keys now. Vhalcha will not display them again.');
      console.log('A local copy was written to .local/seed-keys.json');
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Seed failed');
      process.exit(1);
    });
}
