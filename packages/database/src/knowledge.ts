import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { auditActions } from '@vhalcha/audit';
import {
  clampTopK,
  documentFreshness,
  vectorLiteral,
  type FreshnessState,
  type KnowledgeCitation,
} from '@vhalcha/knowledge';
import type { AppDatabase } from './client';
import { toNumber, toNumeric, slugify } from './money';
import { createRepositories } from './repositories';
import {
  aiSystemKnowledgeAccess,
  aiSystems,
  knowledgeChunks,
  knowledgeDocumentVersions,
  knowledgeDocuments,
  knowledgeIngestionUsage,
  knowledgeRetrievalEvents,
  knowledgeSources,
  knowledgeSpaces,
} from './schema';
import { requireOrganisationId, usingTenant } from './tenant';

export interface RetrievedChunk {
  citation: KnowledgeCitation;
  content: string;
  tokenCount: number;
  freshness: FreshnessState;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  if (result && typeof result === 'object' && 'rows' in result) {
    return ((result as { rows?: T[] }).rows ?? []) as T[];
  }
  return [];
}

export function createKnowledgeRepository(database: AppDatabase) {
  const repos = createRepositories(database);
  return {
    async createSpace(input: {
      organisationId: string;
      name: string;
      description?: string;
      ownerUserId?: string | null;
      defaultFreshnessDays?: number | null;
      actorUserId?: string | null;
    }) {
      requireOrganisationId(input.organisationId);
      return usingTenant(database, input.organisationId, async (tx) => {
        const existing = await tx
          .select({ slug: knowledgeSpaces.slug })
          .from(knowledgeSpaces)
          .where(eq(knowledgeSpaces.organisationId, input.organisationId));
        const base = slugify(input.name);
        let slug = base;
        let suffix = 2;
        while (existing.some((row) => row.slug === slug)) {
          slug = `${base}-${suffix++}`;
        }
        const now = new Date();
        const row = {
          id: randomUUID(),
          organisationId: input.organisationId,
          name: input.name,
          slug,
          description: input.description ?? '',
          status: 'active',
          ownerUserId: input.ownerUserId ?? null,
          defaultFreshnessDays: input.defaultFreshnessDays ?? null,
          createdAt: now,
          updatedAt: now,
        };
        await tx.insert(knowledgeSpaces).values(row);
        await repos.audit.create(input.organisationId, {
          organisationId: input.organisationId,
          actorType: 'user',
          actorId: input.actorUserId ?? null,
          action: auditActions.knowledgeSpaceCreated,
          resourceType: 'knowledge_space',
          resourceId: row.id,
          result: 'success',
          severity: 'info',
          metadata: { knowledge_space_id: row.id, slug },
        });
        return row;
      });
    },
    async listSpaces(organisationId: string) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        return tx
          .select()
          .from(knowledgeSpaces)
          .where(eq(knowledgeSpaces.organisationId, organisationId))
          .orderBy(desc(knowledgeSpaces.updatedAt));
      });
    },
    async getSpace(organisationId: string, spaceId: string) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        const rows = await tx
          .select()
          .from(knowledgeSpaces)
          .where(and(eq(knowledgeSpaces.organisationId, organisationId), eq(knowledgeSpaces.id, spaceId)))
          .limit(1);
        return rows[0] ?? null;
      });
    },
    async updateSpace(
      organisationId: string,
      spaceId: string,
      patch: { name?: string; description?: string; defaultFreshnessDays?: number | null; actorUserId?: string | null },
    ) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        await tx
          .update(knowledgeSpaces)
          .set({
            name: patch.name,
            description: patch.description,
            defaultFreshnessDays: patch.defaultFreshnessDays,
            updatedAt: new Date(),
          })
          .where(and(eq(knowledgeSpaces.organisationId, organisationId), eq(knowledgeSpaces.id, spaceId)));
        await repos.audit.create(organisationId, {
          organisationId,
          actorType: 'user',
          actorId: patch.actorUserId ?? null,
          action: auditActions.knowledgeSpaceUpdated,
          resourceType: 'knowledge_space',
          resourceId: spaceId,
          result: 'success',
          severity: 'info',
          metadata: { knowledge_space_id: spaceId },
        });
      });
    },
    async archiveSpace(organisationId: string, spaceId: string, actorUserId?: string | null) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        await tx
          .update(knowledgeSpaces)
          .set({ status: 'archived', updatedAt: new Date() })
          .where(and(eq(knowledgeSpaces.organisationId, organisationId), eq(knowledgeSpaces.id, spaceId)));
        await repos.audit.create(organisationId, {
          organisationId,
          actorType: 'user',
          actorId: actorUserId ?? null,
          action: auditActions.knowledgeSpaceArchived,
          resourceType: 'knowledge_space',
          resourceId: spaceId,
          result: 'success',
          severity: 'info',
          metadata: { knowledge_space_id: spaceId },
        });
      });
    },
    async createSource(input: {
      organisationId: string;
      knowledgeSpaceId: string;
      name: string;
      sourceType: 'manual_upload' | 'manual_text';
      createdByUserId?: string | null;
    }) {
      requireOrganisationId(input.organisationId);
      return usingTenant(database, input.organisationId, async (tx) => {
        const now = new Date();
        const row = {
          id: randomUUID(),
          organisationId: input.organisationId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          name: input.name,
          sourceType: input.sourceType,
          status: 'active',
          createdByUserId: input.createdByUserId ?? null,
          lastSyncAt: null,
          lastSuccessfulSyncAt: null,
          lastErrorCode: null,
          lastErrorSafe: null,
          createdAt: now,
          updatedAt: now,
        };
        await tx.insert(knowledgeSources).values(row);
        return row;
      });
    },
    async listSources(organisationId: string, spaceId: string) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        return tx
          .select()
          .from(knowledgeSources)
          .where(
            and(eq(knowledgeSources.organisationId, organisationId), eq(knowledgeSources.knowledgeSpaceId, spaceId)),
          )
          .orderBy(desc(knowledgeSources.createdAt));
      });
    },
    async createPendingDocument(input: {
      organisationId: string;
      knowledgeSpaceId: string;
      knowledgeSourceId: string;
      title: string;
      description?: string | null;
      documentType: string;
      mimeType: string;
      ownerUserId?: string | null;
      effectiveDate?: Date | null;
      expiryDate?: Date | null;
      createdByUserId?: string | null;
      contentHash: string;
      extractedText?: string | null;
      storageKey?: string | null;
      originalFilename?: string | null;
      fileSizeBytes?: number | null;
    }) {
      requireOrganisationId(input.organisationId);
      return usingTenant(database, input.organisationId, async (tx) => {
        const current = await tx
          .select()
          .from(knowledgeDocuments)
          .where(
            and(
              eq(knowledgeDocuments.organisationId, input.organisationId),
              eq(knowledgeDocuments.knowledgeSpaceId, input.knowledgeSpaceId),
              eq(knowledgeDocuments.title, input.title),
            ),
          )
          .limit(1);
        const now = new Date();
        let document = current[0];
        let versionNumber = 1;
        if (!document) {
          document = {
            id: randomUUID(),
            organisationId: input.organisationId,
            knowledgeSpaceId: input.knowledgeSpaceId,
            knowledgeSourceId: input.knowledgeSourceId,
            title: input.title,
            description: input.description ?? null,
            documentType: input.documentType,
            mimeType: input.mimeType,
            status: 'processing',
            currentVersionId: null,
            ownerUserId: input.ownerUserId ?? null,
            effectiveDate: input.effectiveDate ?? null,
            expiryDate: input.expiryDate ?? null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          };
          await tx.insert(knowledgeDocuments).values(document);
          await repos.audit.create(input.organisationId, {
            organisationId: input.organisationId,
            actorType: 'user',
            actorId: input.createdByUserId ?? null,
            action: auditActions.knowledgeDocumentUploaded,
            resourceType: 'knowledge_document',
            resourceId: document.id,
            result: 'success',
            severity: 'info',
            metadata: { document_id: document.id, knowledge_space_id: input.knowledgeSpaceId },
          });
        } else {
          const versions = await tx
            .select({ versionNumber: knowledgeDocumentVersions.versionNumber, contentHash: knowledgeDocumentVersions.contentHash, processingStatus: knowledgeDocumentVersions.processingStatus, id: knowledgeDocumentVersions.id })
            .from(knowledgeDocumentVersions)
            .where(eq(knowledgeDocumentVersions.documentId, document.id));
          const readyMatch = versions.find(
            (version) => version.contentHash === input.contentHash && version.processingStatus === 'ready',
          );
          if (readyMatch && document.currentVersionId === readyMatch.id) {
            return { document, versionId: readyMatch.id, versionNumber: readyMatch.versionNumber, duplicate: true };
          }
          versionNumber = versions.reduce((max, version) => Math.max(max, version.versionNumber), 0) + 1;
          await tx
            .update(knowledgeDocuments)
            .set({ status: document.currentVersionId ? document.status : 'processing', updatedAt: now })
            .where(eq(knowledgeDocuments.id, document.id));
        }
        const version = {
          id: randomUUID(),
          organisationId: input.organisationId,
          documentId: document.id,
          versionNumber,
          storageKey: input.storageKey ?? null,
          originalFilename: input.originalFilename ?? null,
          mimeType: input.mimeType,
          fileSizeBytes: input.fileSizeBytes ?? null,
          contentHash: input.contentHash,
          extractedText: input.extractedText ?? null,
          processingStatus: 'pending',
          processingErrorCode: null,
          processingErrorSafe: null,
          ingestAttempts: 0,
          createdByUserId: input.createdByUserId ?? null,
          createdAt: now,
          indexedAt: null,
        };
        await tx.insert(knowledgeDocumentVersions).values(version);
        await repos.audit.create(input.organisationId, {
          organisationId: input.organisationId,
          actorType: 'user',
          actorId: input.createdByUserId ?? null,
          action: auditActions.knowledgeDocumentVersionCreated,
          resourceType: 'knowledge_document_version',
          resourceId: version.id,
          result: 'success',
          severity: 'info',
          metadata: { document_id: document.id, document_version_id: version.id, version_number: versionNumber },
        });
        return { document, versionId: version.id, versionNumber, duplicate: false };
      });
    },
    async listDocuments(organisationId: string, spaceId?: string) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        const filters = [eq(knowledgeDocuments.organisationId, organisationId)];
        if (spaceId) {
          filters.push(eq(knowledgeDocuments.knowledgeSpaceId, spaceId));
        }
        return tx.select().from(knowledgeDocuments).where(and(...filters)).orderBy(desc(knowledgeDocuments.updatedAt));
      });
    },
    async getDocument(organisationId: string, documentId: string) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        const rows = await tx
          .select()
          .from(knowledgeDocuments)
          .where(and(eq(knowledgeDocuments.organisationId, organisationId), eq(knowledgeDocuments.id, documentId)))
          .limit(1);
        return rows[0] ?? null;
      });
    },
    async setVersionStorage(organisationId: string, versionId: string, storageKey: string, fileSizeBytes: number) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        await tx
          .update(knowledgeDocumentVersions)
          .set({ storageKey, fileSizeBytes })
          .where(
            and(
              eq(knowledgeDocumentVersions.organisationId, organisationId),
              eq(knowledgeDocumentVersions.id, versionId),
            ),
          );
      });
    },
    async markVersionPending(organisationId: string, versionId: string) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        await tx
          .update(knowledgeDocumentVersions)
          .set({ processingStatus: 'pending', processingErrorCode: null, processingErrorSafe: null })
          .where(
            and(
              eq(knowledgeDocumentVersions.organisationId, organisationId),
              eq(knowledgeDocumentVersions.id, versionId),
            ),
          );
      });
    },
    async listVersions(organisationId: string, documentId: string) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        return tx
          .select()
          .from(knowledgeDocumentVersions)
          .where(
            and(
              eq(knowledgeDocumentVersions.organisationId, organisationId),
              eq(knowledgeDocumentVersions.documentId, documentId),
            ),
          )
          .orderBy(desc(knowledgeDocumentVersions.versionNumber));
      });
    },
    async archiveDocument(organisationId: string, documentId: string, actorUserId?: string | null) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        const now = new Date();
        await tx
          .update(knowledgeDocuments)
          .set({ status: 'archived', archivedAt: now, updatedAt: now })
          .where(and(eq(knowledgeDocuments.organisationId, organisationId), eq(knowledgeDocuments.id, documentId)));
        await repos.audit.create(organisationId, {
          organisationId,
          actorType: 'user',
          actorId: actorUserId ?? null,
          action: auditActions.knowledgeDocumentArchived,
          resourceType: 'knowledge_document',
          resourceId: documentId,
          result: 'success',
          severity: 'info',
          metadata: { document_id: documentId },
        });
      });
    },
    async grantAccess(input: {
      organisationId: string;
      aiSystemId: string;
      knowledgeSpaceId: string;
      createdByUserId?: string | null;
    }) {
      requireOrganisationId(input.organisationId);
      return usingTenant(database, input.organisationId, async (tx) => {
        const existing = await tx
          .select()
          .from(aiSystemKnowledgeAccess)
          .where(
            and(
              eq(aiSystemKnowledgeAccess.organisationId, input.organisationId),
              eq(aiSystemKnowledgeAccess.aiSystemId, input.aiSystemId),
              eq(aiSystemKnowledgeAccess.knowledgeSpaceId, input.knowledgeSpaceId),
            ),
          )
          .limit(1);
        if (existing[0]) {
          return existing[0];
        }
        const row = {
          id: randomUUID(),
          organisationId: input.organisationId,
          aiSystemId: input.aiSystemId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          accessLevel: 'read',
          createdAt: new Date(),
          createdByUserId: input.createdByUserId ?? null,
        };
        await tx.insert(aiSystemKnowledgeAccess).values(row);
        await repos.audit.create(input.organisationId, {
          organisationId: input.organisationId,
          actorType: 'user',
          actorId: input.createdByUserId ?? null,
          action: auditActions.knowledgeAccessGranted,
          resourceType: 'ai_system_knowledge_access',
          resourceId: row.id,
          result: 'success',
          severity: 'info',
          metadata: { ai_system_id: input.aiSystemId, knowledge_space_id: input.knowledgeSpaceId },
        });
        return row;
      });
    },
    async revokeAccess(organisationId: string, aiSystemId: string, knowledgeSpaceId: string, actorUserId?: string | null) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        await tx
          .delete(aiSystemKnowledgeAccess)
          .where(
            and(
              eq(aiSystemKnowledgeAccess.organisationId, organisationId),
              eq(aiSystemKnowledgeAccess.aiSystemId, aiSystemId),
              eq(aiSystemKnowledgeAccess.knowledgeSpaceId, knowledgeSpaceId),
            ),
          );
        await repos.audit.create(organisationId, {
          organisationId,
          actorType: 'user',
          actorId: actorUserId ?? null,
          action: auditActions.knowledgeAccessRevoked,
          resourceType: 'ai_system_knowledge_access',
          resourceId: knowledgeSpaceId,
          result: 'success',
          severity: 'info',
          metadata: { ai_system_id: aiSystemId, knowledge_space_id: knowledgeSpaceId },
        });
      });
    },
    async listAccessForSpace(organisationId: string, spaceId: string) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        return tx
          .select()
          .from(aiSystemKnowledgeAccess)
          .where(
            and(
              eq(aiSystemKnowledgeAccess.organisationId, organisationId),
              eq(aiSystemKnowledgeAccess.knowledgeSpaceId, spaceId),
            ),
          );
      });
    },
    async updateSystemKnowledge(
      organisationId: string,
      aiSystemId: string,
      patch: {
        knowledgeEnabled?: boolean;
        strictGrounding?: boolean;
        knowledgeTopK?: number;
        minimumSimilarity?: number;
        knowledgeAllowStale?: boolean;
      },
    ) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        await tx
          .update(aiSystems)
          .set({
            knowledgeEnabled: patch.knowledgeEnabled,
            strictGrounding: patch.strictGrounding,
            knowledgeTopK: patch.knowledgeTopK === undefined ? undefined : clampTopK(patch.knowledgeTopK),
            minimumSimilarity:
              patch.minimumSimilarity === undefined ? undefined : toNumeric(patch.minimumSimilarity, 5),
            knowledgeAllowStale: patch.knowledgeAllowStale,
            updatedAt: new Date(),
          })
          .where(and(eq(aiSystems.organisationId, organisationId), eq(aiSystems.id, aiSystemId)));
      });
    },
    async recordRetrieval(
      organisationId: string,
      rows: Array<{
        requestId: string;
        aiSystemId: string;
        knowledgeSpaceId: string;
        documentId: string;
        documentVersionId: string;
        chunkId: string;
        rank: number;
        similarity: number;
      }>,
    ) {
      requireOrganisationId(organisationId);
      if (rows.length === 0) {
        return;
      }
      return usingTenant(database, organisationId, async (tx) => {
        await tx.insert(knowledgeRetrievalEvents).values(
          rows.map((row) => ({
            id: randomUUID(),
            organisationId,
            requestId: row.requestId,
            aiSystemId: row.aiSystemId,
            knowledgeSpaceId: row.knowledgeSpaceId,
            documentId: row.documentId,
            documentVersionId: row.documentVersionId,
            chunkId: row.chunkId,
            rank: row.rank,
            similarityScore: toNumeric(row.similarity, 6),
            createdAt: new Date(),
          })),
        );
      });
    },
    async listRetrievalForRequest(organisationId: string, requestId: string) {
      requireOrganisationId(organisationId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
        return [];
      }
      return usingTenant(database, organisationId, async (tx) => {
        return tx
          .select()
          .from(knowledgeRetrievalEvents)
          .where(
            and(
              eq(knowledgeRetrievalEvents.organisationId, organisationId),
              eq(knowledgeRetrievalEvents.requestId, requestId),
            ),
          );
      });
    },
    async listIngestionUsage(organisationId: string) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        return tx
          .select()
          .from(knowledgeIngestionUsage)
          .where(eq(knowledgeIngestionUsage.organisationId, organisationId))
          .orderBy(desc(knowledgeIngestionUsage.createdAt));
      });
    },
    async chunkCount(organisationId: string, versionId: string) {
      requireOrganisationId(organisationId);
      return usingTenant(database, organisationId, async (tx) => {
        const rows = await tx
          .select({ id: knowledgeChunks.id })
          .from(knowledgeChunks)
          .where(
            and(eq(knowledgeChunks.organisationId, organisationId), eq(knowledgeChunks.documentVersionId, versionId)),
          );
        return rows.length;
      });
    },
    async retrieve(input: {
      organisationId: string;
      aiSystemId: string;
      queryVector: number[];
      embeddingModel: string;
      topK?: number;
      minimumSimilarity?: number;
      strictGrounding: boolean;
      allowStale: boolean;
      requestedSpaceIds?: string[];
    }): Promise<RetrievedChunk[]> {
      requireOrganisationId(input.organisationId);
      const topK = clampTopK(input.topK);
      const minimumSimilarity = input.minimumSimilarity ?? 0.2;
      const allowStale = input.allowStale && !input.strictGrounding;
      return usingTenant(database, input.organisationId, async (tx) => {
        const grants = await tx
          .select({ spaceId: aiSystemKnowledgeAccess.knowledgeSpaceId })
          .from(aiSystemKnowledgeAccess)
          .where(
            and(
              eq(aiSystemKnowledgeAccess.organisationId, input.organisationId),
              eq(aiSystemKnowledgeAccess.aiSystemId, input.aiSystemId),
              eq(aiSystemKnowledgeAccess.accessLevel, 'read'),
            ),
          );
        let spaceIds = grants.map((grant) => grant.spaceId);
        if (input.requestedSpaceIds && input.requestedSpaceIds.length > 0) {
          const requested = new Set(input.requestedSpaceIds);
          spaceIds = spaceIds.filter((spaceId) => requested.has(spaceId));
        }
        if (spaceIds.length === 0) {
          return [];
        }
        const literal = vectorLiteral(input.queryVector);
        const spaceList = sql.join(
          spaceIds.map((spaceId) => sql`${spaceId}::uuid`),
          sql`, `,
        );
        const result = await tx.execute(sql`
          select
            c.id as chunk_id,
            c.content,
            c.token_count,
            c.chunk_index,
            c.page_number,
            c.section_title,
            d.id as document_id,
            d.title as document_title,
            d.expiry_date,
            d.status as document_status,
            v.id as document_version_id,
            v.indexed_at,
            s.id as knowledge_space_id,
            s.name as knowledge_space_name,
            s.default_freshness_days,
            (1 - (e.embedding <=> ${literal}::vector)) as similarity
          from knowledge_chunk_embeddings e
          join knowledge_chunks c on c.id = e.chunk_id
          join knowledge_document_versions v on v.id = c.document_version_id
          join knowledge_documents d on d.id = c.document_id and d.current_version_id = v.id
          join knowledge_spaces s on s.id = c.knowledge_space_id
          where e.organisation_id = ${input.organisationId}::uuid
            and e.embedding_model = ${input.embeddingModel}
            and e.embedding_dimensions = 1536
            and s.id in (${spaceList})
            and s.status = 'active'
            and d.status = 'ready'
            and d.archived_at is null
            and v.processing_status = 'ready'
            and (d.effective_date is null or d.effective_date <= now())
            and (d.expiry_date is null or d.expiry_date > now())
            and (
              ${allowStale}::boolean
              or s.default_freshness_days is null
              or v.indexed_at is null
              or v.indexed_at >= now() - make_interval(days => s.default_freshness_days)
            )
            and (1 - (e.embedding <=> ${literal}::vector)) >= ${minimumSimilarity}
          order by e.embedding <=> ${literal}::vector
          limit ${topK}
        `);
        const rows = resultRows<{
          chunk_id: string;
          content: string;
          token_count: number;
          chunk_index: number;
          page_number: number | null;
          section_title: string | null;
          document_id: string;
          document_title: string;
          expiry_date: Date | string | null;
          document_status: string;
          document_version_id: string;
          indexed_at: Date | string | null;
          knowledge_space_id: string;
          knowledge_space_name: string;
          default_freshness_days: number | null;
          similarity: number | string;
        }>(result);
        return rows.map((row, index) => {
          const similarity = toNumber(row.similarity);
          const freshness = documentFreshness({
            status: row.document_status,
            expiryDate: row.expiry_date ? new Date(row.expiry_date) : null,
            indexedAt: row.indexed_at ? new Date(row.indexed_at) : null,
            freshnessDays: row.default_freshness_days,
          });
          return {
            content: row.content,
            tokenCount: Number(row.token_count),
            freshness,
            citation: {
              citationId: `S${index + 1}`,
              documentId: row.document_id,
              documentVersionId: row.document_version_id,
              documentTitle: row.document_title,
              knowledgeSpaceId: row.knowledge_space_id,
              knowledgeSpaceName: row.knowledge_space_name,
              pageNumber: row.page_number,
              sectionTitle: row.section_title,
              chunkIndex: Number(row.chunk_index),
              chunkId: row.chunk_id,
              similarity,
            },
          };
        });
      });
    },
  };
}
