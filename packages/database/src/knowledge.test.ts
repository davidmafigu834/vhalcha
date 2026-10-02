import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createMockEmbeddingProvider, MemoryKnowledgeObjectStore, contentHash } from '@vhalcha/knowledge';
import type { AppDatabase } from './client';
import { indexKnowledgeVersion } from './knowledge-ingest';
import { createKnowledgeRepository } from './knowledge';
import { createRepositories } from './repositories';
import { createTestDatabase } from './testing/harness';
import { usingTenant } from './tenant';

const CANARY = 'CONFIDENTIAL_KNOWLEDGE_CANARY_984273';

async function readyText(input: {
  db: AppDatabase;
  organisationId: string;
  spaceId: string;
  title: string;
  text: string;
  expiryDate?: Date | null;
}) {
  const knowledge = createKnowledgeRepository(input.db);
  const source = await knowledge.createSource({
    organisationId: input.organisationId,
    knowledgeSpaceId: input.spaceId,
    name: input.title,
    sourceType: 'manual_text',
  });
  const created = await knowledge.createPendingDocument({
    organisationId: input.organisationId,
    knowledgeSpaceId: input.spaceId,
    knowledgeSourceId: source.id,
    title: input.title,
    documentType: 'text',
    mimeType: 'text/plain',
    contentHash: contentHash(input.text),
    extractedText: input.text,
    expiryDate: input.expiryDate,
  });
  await indexKnowledgeVersion(input.db, {
    organisationId: input.organisationId,
    documentVersionId: created.versionId,
    embedder: createMockEmbeddingProvider(),
    store: new MemoryKnowledgeObjectStore(),
  });
  return created;
}

describe('knowledge retrieval and tenant isolation', () => {
  it('retrieves only the granted current version and hides other tenants', async () => {
    const { db, client } = await createTestDatabase();
    const appDb = db as unknown as AppDatabase;
    const repos = createRepositories(appDb);
    const knowledge = createKnowledgeRepository(appDb);
    const orgA = await repos.organisations.create({ name: 'Organisation A', slug: 'know-a' });
    const orgB = await repos.organisations.create({ name: 'Organisation B', slug: 'know-b' });
    const envA = await repos.environments.create({ organisationId: orgA.id, name: 'Development', type: 'development' });
    const envB = await repos.environments.create({ organisationId: orgB.id, name: 'Development', type: 'development' });
    const systemA = await repos.registerAiSystem({
      organisationId: orgA.id,
      environmentId: envA.id,
      name: 'Support A',
      description: 'A',
      type: 'assistant',
      riskLevel: 'low',
      monthlyBudgetUsd: 10,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: false,
    });
    const systemB = await repos.registerAiSystem({
      organisationId: orgB.id,
      environmentId: envB.id,
      name: 'Support B',
      description: 'B',
      type: 'assistant',
      riskLevel: 'low',
      monthlyBudgetUsd: 10,
      modelPattern: 'gpt-4.1-mini',
      requestsPerMinute: 60,
      generateKey: false,
    });
    const spaceA = await knowledge.createSpace({ organisationId: orgA.id, name: 'Support' });
    const spaceHidden = await knowledge.createSpace({ organisationId: orgA.id, name: 'Finance' });
    const spaceB = await knowledge.createSpace({ organisationId: orgB.id, name: 'Secret Pricing' });
    const first = await readyText({
      db: appDb,
      organisationId: orgA.id,
      spaceId: spaceA.id,
      title: 'Returns Policy',
      text: 'The returns policy allows refunds within 30 days.',
    });
    await readyText({
      db: appDb,
      organisationId: orgA.id,
      spaceId: spaceHidden.id,
      title: 'Finance Policy',
      text: 'The returns policy finance addendum is confidential.',
    });
    const secretDocument = await readyText({
      db: appDb,
      organisationId: orgB.id,
      spaceId: spaceB.id,
      title: 'Secret Pricing',
      text: `${CANARY} secret pricing for organisation B.`,
    });
    await knowledge.grantAccess({
      organisationId: orgA.id,
      aiSystemId: systemA.system.id,
      knowledgeSpaceId: spaceA.id,
    });
    const embedder = createMockEmbeddingProvider();
    const query = await embedder.embedQuery('returns policy');
    const allowed = await knowledge.retrieve({
      organisationId: orgA.id,
      aiSystemId: systemA.system.id,
      queryVector: query,
      embeddingModel: embedder.model,
      strictGrounding: false,
      allowStale: false,
      requestedSpaceIds: [spaceHidden.id, spaceB.id, spaceA.id],
    });
    expect(allowed.every((row) => row.citation.knowledgeSpaceId === spaceA.id)).toBe(true);
    expect(allowed.some((row) => row.content.includes(CANARY))).toBe(false);
    const denied = await knowledge.retrieve({
      organisationId: orgA.id,
      aiSystemId: systemA.system.id,
      queryVector: query,
      embeddingModel: embedder.model,
      strictGrounding: true,
      allowStale: true,
      requestedSpaceIds: [spaceB.id],
    });
    expect(denied).toEqual([]);

    const replacement = 'The returns policy now allows refunds within 14 days only.';
    const source = await knowledge.createSource({
      organisationId: orgA.id,
      knowledgeSpaceId: spaceA.id,
      name: 'Returns v2',
      sourceType: 'manual_text',
    });
    const next = await knowledge.createPendingDocument({
      organisationId: orgA.id,
      knowledgeSpaceId: spaceA.id,
      knowledgeSourceId: source.id,
      title: 'Returns Policy',
      documentType: 'text',
      mimeType: 'text/plain',
      contentHash: contentHash(replacement),
      extractedText: replacement,
    });
    const during = await knowledge.retrieve({
      organisationId: orgA.id,
      aiSystemId: systemA.system.id,
      queryVector: await embedder.embedQuery('returns policy'),
      embeddingModel: embedder.model,
      strictGrounding: false,
      allowStale: false,
    });
    expect(during.some((row) => row.content.includes('30 days'))).toBe(true);
    expect(during.some((row) => row.content.includes('14 days'))).toBe(false);
    await indexKnowledgeVersion(appDb, {
      organisationId: orgA.id,
      documentVersionId: next.versionId,
      embedder,
      store: new MemoryKnowledgeObjectStore(),
    });
    const after = await knowledge.retrieve({
      organisationId: orgA.id,
      aiSystemId: systemA.system.id,
      queryVector: await embedder.embedQuery('returns policy'),
      embeddingModel: embedder.model,
      strictGrounding: false,
      allowStale: false,
    });
    expect(after.some((row) => row.content.includes('14 days'))).toBe(true);
    expect(after.every((row) => row.citation.documentVersionId === next.versionId)).toBe(true);

    const expired = await readyText({
      db: appDb,
      organisationId: orgA.id,
      spaceId: spaceA.id,
      title: 'Expired Notice',
      text: 'The returns policy expired notice should not be retrieved.',
      expiryDate: new Date('2020-01-01'),
    });
    const expiredHits = await knowledge.retrieve({
      organisationId: orgA.id,
      aiSystemId: systemA.system.id,
      queryVector: await embedder.embedQuery('expired notice returns policy'),
      embeddingModel: embedder.model,
      strictGrounding: false,
      allowStale: true,
    });
    expect(expiredHits.some((row) => row.citation.documentId === expired.document.id)).toBe(false);
    await knowledge.archiveDocument(orgA.id, first.document.id);
    const archived = await knowledge.retrieve({
      organisationId: orgA.id,
      aiSystemId: systemA.system.id,
      queryVector: await embedder.embedQuery('returns policy'),
      embeddingModel: embedder.model,
      strictGrounding: false,
      allowStale: false,
    });
    expect(archived.some((row) => row.citation.documentId === first.document.id)).toBe(false);

    const audits = await repos.audit.list(orgA.id);
    expect(JSON.stringify(audits)).not.toContain(CANARY);
    await expect(
      knowledge.grantAccess({
        organisationId: orgA.id,
        aiSystemId: systemB.system.id,
        knowledgeSpaceId: spaceB.id,
      }),
    ).rejects.toThrow();

    await client.exec('set role vhalcha_app');
    const hidden = await usingTenant(appDb, orgA.id, async (tx) => tx.execute(sql`select id from knowledge_documents`));
    const hiddenRows = Array.isArray(hidden)
      ? hidden
      : ((hidden as unknown as { rows?: Array<{ id: string }> }).rows ?? []);
    const ids = hiddenRows.map((row) => String(row.id));
    expect(ids).not.toContain(secretDocument.document.id);
    await expect(
      usingTenant(appDb, orgA.id, async (tx) =>
        tx.execute(sql`
          insert into knowledge_documents (
            id, organisation_id, knowledge_space_id, title, document_type, status
          ) values (
            ${crypto.randomUUID()}::uuid,
            ${orgB.id}::uuid,
            ${spaceB.id}::uuid,
            'Stolen',
            'text',
            'ready'
          )
        `),
      ),
    ).rejects.toThrow();
    await client.close();
  });
});
