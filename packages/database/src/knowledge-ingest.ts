import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { auditActions } from '@vhalcha/audit';
import {
  chunkText,
  estimateEmbeddingCostUsd,
  estimateTokens,
  extractDocument,
  knowledgeLimits,
  safeProcessingMessage,
  type EmbeddingProvider,
  type KnowledgeObjectStore,
} from '@vhalcha/knowledge';
import type { AppDatabase } from './client';
import { toNumeric } from './money';
import { createRepositories } from './repositories';
import {
  knowledgeChunkEmbeddings,
  knowledgeChunks,
  knowledgeDocumentVersions,
  knowledgeDocuments,
  knowledgeIngestionUsage,
  knowledgeSources,
} from './schema';
import { requireOrganisationId, usingTenant } from './tenant';

const nonRetryable = new Set([
  'file_too_large',
  'unsupported_file_type',
  'unsupported_scanned_document',
  'too_many_pages',
  'extracted_text_too_large',
  'extraction_failed',
  'embedding_dimensions_mismatch',
  'knowledge_object_forbidden',
  'knowledge_version_missing',
]);

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'indexing_failed';
}

function retryable(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error) {
    return Boolean((error as { retryable?: boolean }).retryable);
  }
  return !nonRetryable.has(errorCode(error));
}

async function markStatus(
  db: AppDatabase,
  organisationId: string,
  versionId: string,
  processingStatus: string,
) {
  await usingTenant(db, organisationId, async (tx) => {
    await tx
      .update(knowledgeDocumentVersions)
      .set({ processingStatus })
      .where(
        and(eq(knowledgeDocumentVersions.organisationId, organisationId), eq(knowledgeDocumentVersions.id, versionId)),
      );
  });
}

async function markFailed(db: AppDatabase, organisationId: string, versionId: string, code: string) {
  const message = safeProcessingMessage(code);
  await usingTenant(db, organisationId, async (tx) => {
    const versions = await tx
      .select()
      .from(knowledgeDocumentVersions)
      .where(
        and(eq(knowledgeDocumentVersions.organisationId, organisationId), eq(knowledgeDocumentVersions.id, versionId)),
      )
      .limit(1);
    const version = versions[0];
    if (!version) {
      return;
    }
    await tx
      .update(knowledgeDocumentVersions)
      .set({
        processingStatus: 'failed',
        processingErrorCode: code,
        processingErrorSafe: message,
      })
      .where(eq(knowledgeDocumentVersions.id, versionId));
    const documents = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, version.documentId))
      .limit(1);
    const document = documents[0];
    if (document && document.currentVersionId !== versionId) {
      if (!document.currentVersionId) {
        await tx
          .update(knowledgeDocuments)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(knowledgeDocuments.id, document.id));
      }
    }
    if (document?.knowledgeSourceId) {
      await tx
        .update(knowledgeSources)
        .set({
          status: 'failed',
          lastErrorCode: code,
          lastErrorSafe: message,
          lastSyncAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(knowledgeSources.id, document.knowledgeSourceId));
    }
    await createRepositories(tx as unknown as AppDatabase).audit.create(organisationId, {
      organisationId,
      actorType: 'system',
      action: auditActions.knowledgeDocumentFailed,
      resourceType: 'knowledge_document',
      resourceId: version.documentId,
      result: 'failure',
      severity: 'warning',
      metadata: { document_id: version.documentId, document_version_id: versionId, error_code: code },
    });
  });
}

export async function indexKnowledgeVersion(
  db: AppDatabase,
  input: {
    organisationId: string;
    documentVersionId: string;
    embedder: EmbeddingProvider;
    store: KnowledgeObjectStore;
    force?: boolean;
  },
) {
  requireOrganisationId(input.organisationId);
  const loaded = await usingTenant(db, input.organisationId, async (tx) => {
    const versions = await tx
      .select()
      .from(knowledgeDocumentVersions)
      .where(
        and(
          eq(knowledgeDocumentVersions.organisationId, input.organisationId),
          eq(knowledgeDocumentVersions.id, input.documentVersionId),
        ),
      )
      .limit(1);
    const version = versions[0];
    if (!version) {
      return null;
    }
    const documents = await tx
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, version.documentId))
      .limit(1);
    const nextAttempts = version.ingestAttempts + 1;
    await tx
      .update(knowledgeDocumentVersions)
      .set({ ingestAttempts: nextAttempts, processingErrorCode: null, processingErrorSafe: null })
      .where(eq(knowledgeDocumentVersions.id, version.id));
    return { version: { ...version, ingestAttempts: nextAttempts }, document: documents[0] ?? null };
  });
  if (!loaded?.document) {
    throw Object.assign(new Error('knowledge_version_missing'), {
      code: 'knowledge_version_missing',
      retryable: false,
    });
  }
  if (loaded.version.processingStatus === 'ready' && !input.force) {
    return { ready: true, attempts: loaded.version.ingestAttempts };
  }
  const wasReady = loaded.version.processingStatus === 'ready';
  try {
    await markStatus(db, input.organisationId, loaded.version.id, 'extracting');
    let text = loaded.version.extractedText ?? '';
    let pageText: Array<{ pageNumber: number; text: string }> = [];
    if (!text) {
      if (!loaded.version.storageKey) {
        throw Object.assign(new Error('extraction_failed'), { code: 'extraction_failed', retryable: false });
      }
      const bytes = await input.store.get(input.organisationId, loaded.version.storageKey);
      const extracted = await extractDocument({
        mimeType: loaded.version.mimeType ?? 'application/octet-stream',
        buffer: bytes,
      });
      text = extracted.text;
      pageText = extracted.pageText;
      await usingTenant(db, input.organisationId, async (tx) => {
        await tx
          .update(knowledgeDocumentVersions)
          .set({ extractedText: text })
          .where(eq(knowledgeDocumentVersions.id, loaded.version.id));
      });
    }
    await markStatus(db, input.organisationId, loaded.version.id, 'chunking');
    const chunks =
      pageText.length > 0
        ? pageText.flatMap((page) => chunkText(page.text, { pageNumber: page.pageNumber }))
        : chunkText(text);
    chunks.forEach((chunk, index) => {
      chunk.chunkIndex = index;
    });
    if (chunks.length === 0) {
      throw Object.assign(new Error('extraction_failed'), { code: 'extraction_failed', retryable: false });
    }
    await markStatus(db, input.organisationId, loaded.version.id, 'embedding');
    const vectors = await input.embedder.embedDocuments(chunks.map((chunk) => chunk.content));
    if (vectors.length !== chunks.length || vectors.some((vector) => vector.length !== knowledgeLimits.embeddingDimensions)) {
      throw Object.assign(new Error('embedding_dimensions_mismatch'), {
        code: 'embedding_dimensions_mismatch',
        retryable: false,
      });
    }
    const chunkRows = chunks.map((chunk) => ({
      id: randomUUID(),
      organisationId: input.organisationId,
      knowledgeSpaceId: loaded.document!.knowledgeSpaceId,
      documentId: loaded.document!.id,
      documentVersionId: loaded.version.id,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      tokenCount: chunk.tokenCount,
      pageNumber: chunk.pageNumber,
      sectionTitle: chunk.sectionTitle,
      contentHash: chunk.contentHash,
      createdAt: new Date(),
    }));
    const inputTokens = chunkRows.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
    await usingTenant(db, input.organisationId, async (tx) => {
      await tx
        .delete(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.organisationId, input.organisationId),
            eq(knowledgeChunks.documentVersionId, loaded.version.id),
          ),
        );
      await tx.insert(knowledgeChunks).values(chunkRows);
      await tx.insert(knowledgeChunkEmbeddings).values(
        chunkRows.map((chunk, index) => ({
          id: randomUUID(),
          organisationId: input.organisationId,
          chunkId: chunk.id,
          embeddingModel: input.embedder.model,
          embeddingDimensions: input.embedder.dimensions,
          embedding: vectors[index] ?? [],
          createdAt: new Date(),
        })),
      );
      await tx.insert(knowledgeIngestionUsage).values({
        id: randomUUID(),
        organisationId: input.organisationId,
        documentId: loaded.document!.id,
        documentVersionId: loaded.version.id,
        embeddingProvider: input.embedder.id,
        embeddingModel: input.embedder.model,
        inputTokens,
        estimatedCostUsd: toNumeric(estimateEmbeddingCostUsd(inputTokens), 6),
        createdAt: new Date(),
      });
      const indexedAt = new Date();
      await tx
        .update(knowledgeDocumentVersions)
        .set({ processingStatus: 'ready', indexedAt, processingErrorCode: null, processingErrorSafe: null })
        .where(eq(knowledgeDocumentVersions.id, loaded.version.id));
      await tx
        .update(knowledgeDocuments)
        .set({
          status: 'ready',
          currentVersionId: loaded.version.id,
          updatedAt: indexedAt,
        })
        .where(eq(knowledgeDocuments.id, loaded.document!.id));
      if (loaded.document?.knowledgeSourceId) {
        await tx
          .update(knowledgeSources)
          .set({
            status: 'active',
            lastSyncAt: indexedAt,
            lastSuccessfulSyncAt: indexedAt,
            lastErrorCode: null,
            lastErrorSafe: null,
            updatedAt: indexedAt,
          })
          .where(eq(knowledgeSources.id, loaded.document.knowledgeSourceId));
      }
      await createRepositories(tx as unknown as AppDatabase).audit.create(input.organisationId, {
        organisationId: input.organisationId,
        actorType: 'system',
        action: auditActions.knowledgeDocumentIndexed,
        resourceType: 'knowledge_document',
        resourceId: loaded.document!.id,
        result: 'success',
        severity: 'info',
        metadata: {
          document_id: loaded.document!.id,
          document_version_id: loaded.version.id,
          chunk_count: chunkRows.length,
          embedding_model: input.embedder.model,
          input_tokens: inputTokens,
        },
      });
    });
    return { ready: true, attempts: loaded.version.ingestAttempts, tokens: estimateTokens(text) };
  } catch (error) {
    const code = errorCode(error);
    const again = retryable(error) && loaded.version.ingestAttempts < knowledgeLimits.maxIngestAttempts;
    if (wasReady) {
      await markStatus(db, input.organisationId, loaded.version.id, 'ready');
      throw error;
    }
    if (!again) {
      await markFailed(db, input.organisationId, loaded.version.id, code);
      throw Object.assign(error instanceof Error ? error : new Error(code), { retryable: false, code });
    }
    throw error;
  }
}
