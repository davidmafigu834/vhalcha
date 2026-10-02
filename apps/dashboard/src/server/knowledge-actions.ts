'use server';

import { redirect } from 'next/navigation';
import { contentHash, createKnowledgeObjectStore, knowledgeLimits, objectKey } from '@vhalcha/knowledge';
import { redisKeys } from '@vhalcha/redis';
import { getServices, requirePermission } from './services';
import { createKnowledgeRepository } from '@vhalcha/database';

function optionalDate(value: FormDataEntryValue | null): Date | null {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function enqueueIngest(organisationId: string, documentVersionId: string, force = false) {
  const redis = getServices().redis;
  if (!redis) {
    throw new Error('Knowledge indexing queue is unavailable.');
  }
  await redis.enqueue(
    redisKeys.queue(),
    JSON.stringify({ type: 'knowledge.ingest', organisationId, documentVersionId, force }),
  );
}

export async function createKnowledgeSpace(formData: FormData) {
  const session = await requirePermission('knowledge:write');
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const freshness = String(formData.get('freshness_days') ?? '').trim();
  if (!name) {
    throw new Error('A space name is required.');
  }
  const knowledge = createKnowledgeRepository(getServices().db);
  const space = await knowledge.createSpace({
    organisationId: session.claims.oid,
    name,
    description,
    ownerUserId: session.claims.uid,
    defaultFreshnessDays: freshness ? Number(freshness) : null,
    actorUserId: session.claims.uid,
  });
  redirect(`/knowledge/spaces/${space.id}`);
}

export async function archiveKnowledgeSpace(formData: FormData) {
  const session = await requirePermission('knowledge:write');
  const spaceId = String(formData.get('space_id') ?? '');
  await createKnowledgeRepository(getServices().db).archiveSpace(session.claims.oid, spaceId, session.claims.uid);
  redirect('/knowledge/spaces');
}

export async function uploadKnowledgeText(formData: FormData) {
  const session = await requirePermission('knowledge:write');
  const spaceId = String(formData.get('space_id') ?? '');
  const title = String(formData.get('title') ?? '').trim();
  const text = String(formData.get('text') ?? '');
  if (!title || !text.trim()) {
    throw new Error('A title and text are required.');
  }
  if (Buffer.byteLength(text) > knowledgeLimits.maxFileBytes) {
    throw new Error('This text is larger than the 20 MB limit.');
  }
  const knowledge = createKnowledgeRepository(getServices().db);
  const source = await knowledge.createSource({
    organisationId: session.claims.oid,
    knowledgeSpaceId: spaceId,
    name: title,
    sourceType: 'manual_text',
    createdByUserId: session.claims.uid,
  });
  const created = await knowledge.createPendingDocument({
    organisationId: session.claims.oid,
    knowledgeSpaceId: spaceId,
    knowledgeSourceId: source.id,
    title,
    documentType: 'text',
    mimeType: 'text/plain',
    ownerUserId: session.claims.uid,
    effectiveDate: optionalDate(formData.get('effective_date')),
    expiryDate: optionalDate(formData.get('expiry_date')),
    createdByUserId: session.claims.uid,
    contentHash: contentHash(text),
    extractedText: text,
    originalFilename: `${title}.txt`,
    fileSizeBytes: Buffer.byteLength(text),
  });
  if (!created.duplicate) {
    await enqueueIngest(session.claims.oid, created.versionId);
  }
  redirect(`/knowledge/documents/${created.document.id}`);
}

export async function uploadKnowledgeFile(formData: FormData) {
  const session = await requirePermission('knowledge:write');
  const spaceId = String(formData.get('space_id') ?? '');
  const title = String(formData.get('title') ?? '').trim();
  const file = formData.get('file');
  if (!title || !(file instanceof File) || file.size === 0) {
    throw new Error('Choose a file and a title.');
  }
  if (file.size > knowledgeLimits.maxFileBytes) {
    throw new Error('This file is larger than the 20 MB upload limit.');
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const knowledge = createKnowledgeRepository(getServices().db);
  const source = await knowledge.createSource({
    organisationId: session.claims.oid,
    knowledgeSpaceId: spaceId,
    name: title,
    sourceType: 'manual_upload',
    createdByUserId: session.claims.uid,
  });
  const created = await knowledge.createPendingDocument({
    organisationId: session.claims.oid,
    knowledgeSpaceId: spaceId,
    knowledgeSourceId: source.id,
    title,
    documentType: 'file',
    mimeType: file.type || 'application/octet-stream',
    ownerUserId: session.claims.uid,
    effectiveDate: optionalDate(formData.get('effective_date')),
    expiryDate: optionalDate(formData.get('expiry_date')),
    createdByUserId: session.claims.uid,
    contentHash: contentHash(bytes),
    originalFilename: file.name,
    fileSizeBytes: bytes.byteLength,
  });
  if (!created.duplicate) {
    const storageKey = objectKey(session.claims.oid, created.document.id, created.versionId);
    const store = await createKnowledgeObjectStore();
    await store.put({
      organisationId: session.claims.oid,
      documentId: created.document.id,
      versionId: created.versionId,
      bytes,
    });
    await knowledge.setVersionStorage(session.claims.oid, created.versionId, storageKey, bytes.byteLength);
    await enqueueIngest(session.claims.oid, created.versionId);
  }
  redirect(`/knowledge/documents/${created.document.id}`);
}

export async function archiveKnowledgeDocument(formData: FormData) {
  const session = await requirePermission('knowledge:write');
  const documentId = String(formData.get('document_id') ?? '');
  await createKnowledgeRepository(getServices().db).archiveDocument(session.claims.oid, documentId, session.claims.uid);
  redirect(`/knowledge/documents/${documentId}`);
}

export async function reindexKnowledgeDocument(formData: FormData) {
  const session = await requirePermission('knowledge:write');
  const versionId = String(formData.get('version_id') ?? '');
  const documentId = String(formData.get('document_id') ?? '');
  await createKnowledgeRepository(getServices().db).markVersionPending(session.claims.oid, versionId);
  await enqueueIngest(session.claims.oid, versionId, true);
  redirect(`/knowledge/documents/${documentId}`);
}

export async function grantKnowledgeAccess(formData: FormData) {
  const session = await requirePermission('knowledge:manage_access');
  const spaceId = String(formData.get('space_id') ?? '');
  const aiSystemId = String(formData.get('ai_system_id') ?? '');
  await createKnowledgeRepository(getServices().db).grantAccess({
    organisationId: session.claims.oid,
    aiSystemId,
    knowledgeSpaceId: spaceId,
    createdByUserId: session.claims.uid,
  });
  redirect(`/knowledge/spaces/${spaceId}?tab=access`);
}

export async function revokeKnowledgeAccess(formData: FormData) {
  const session = await requirePermission('knowledge:manage_access');
  const spaceId = String(formData.get('space_id') ?? '');
  const aiSystemId = String(formData.get('ai_system_id') ?? '');
  await createKnowledgeRepository(getServices().db).revokeAccess(
    session.claims.oid,
    aiSystemId,
    spaceId,
    session.claims.uid,
  );
  redirect(`/knowledge/spaces/${spaceId}?tab=access`);
}

export async function updateKnowledgeSettings(formData: FormData) {
  const session = await requirePermission('knowledge:write');
  const spaceId = String(formData.get('space_id') ?? '');
  const freshness = String(formData.get('freshness_days') ?? '').trim();
  await createKnowledgeRepository(getServices().db).updateSpace(session.claims.oid, spaceId, {
    description: String(formData.get('description') ?? ''),
    defaultFreshnessDays: freshness ? Number(freshness) : null,
    actorUserId: session.claims.uid,
  });
  redirect(`/knowledge/spaces/${spaceId}?tab=settings`);
}

export async function updateSystemKnowledge(formData: FormData) {
  const session = await requirePermission('ai_systems:write');
  await requirePermission('knowledge:manage_access');
  const aiSystemId = String(formData.get('ai_system_id') ?? '');
  await createKnowledgeRepository(getServices().db).updateSystemKnowledge(session.claims.oid, aiSystemId, {
    knowledgeEnabled: formData.get('knowledge_enabled') === 'on',
    strictGrounding: formData.get('strict_grounding') === 'on',
    knowledgeAllowStale: formData.get('allow_stale') === 'on',
    knowledgeTopK: Number(formData.get('top_k') ?? 6),
    minimumSimilarity: Number(formData.get('minimum_similarity') ?? 0.2),
  });
  redirect('/knowledge');
}
