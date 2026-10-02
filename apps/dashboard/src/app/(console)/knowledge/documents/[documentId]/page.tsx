import Link from 'next/link';
import { createKnowledgeRepository, createRepositories } from '@vhalcha/database';
import { documentFreshness } from '@vhalcha/knowledge';
import { AccessDenied } from '../../../../../components/access-denied';
import { getServices, requirePageAccess } from '../../../../../server/services';
import { archiveKnowledgeDocument, reindexKnowledgeDocument } from '../../../../../server/knowledge-actions';

export const metadata = { title: 'Knowledge Document' };

const stageLabel: Record<string, string> = {
  pending: 'Uploaded',
  extracting: 'Extracting',
  chunking: 'Chunking',
  embedding: 'Embedding',
  ready: 'Ready',
  failed: 'Failed',
};

export default async function KnowledgeDocumentPage({ params }: { params: Promise<{ documentId: string }> }) {
  const access = await requirePageAccess('knowledge:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const { documentId } = await params;
  const organisationId = access.claims.oid;
  const db = getServices().db;
  const knowledge = createKnowledgeRepository(db);
  const repos = createRepositories(db);
  const document = await knowledge.getDocument(organisationId, documentId);
  if (!document) return <p className="empty">This document is not available.</p>;
  const [space, versions, sources, grants, systems, users, audits] = await Promise.all([
    knowledge.getSpace(organisationId, document.knowledgeSpaceId),
    knowledge.listVersions(organisationId, document.id),
    knowledge.listSources(organisationId, document.knowledgeSpaceId),
    knowledge.listAccessForSpace(organisationId, document.knowledgeSpaceId),
    repos.aiSystems.list(organisationId),
    repos.users.list(organisationId),
    repos.audit.list(organisationId),
  ]);
  const current = versions.find((version) => version.id === document.currentVersionId) ?? null;
  const chunks = current ? await knowledge.chunkCount(organisationId, current.id) : 0;
  const usage = await knowledge.listIngestionUsage(organisationId);
  const embedding = usage.find((row) => row.documentVersionId === current?.id);
  const freshness = documentFreshness({
    status: document.status,
    expiryDate: document.expiryDate,
    indexedAt: current?.indexedAt ?? null,
    freshnessDays: space?.defaultFreshnessDays ?? null,
  });
  const source = sources.find((row) => row.id === document.knowledgeSourceId);
  return (
    <>
      <h1 className="page-title">{document.title}</h1>
      <article className="panel">
        <p>Space <Link href={`/knowledge/spaces/${document.knowledgeSpaceId}`}>{space?.name ?? 'Space'}</Link></p>
        <p>Source {source?.name ?? '—'} · {source?.sourceType ?? '—'}</p>
        <p>Status {document.status}</p>
        <p>Current version {current ? `v${current.versionNumber}` : 'none'}</p>
        <p>Created {document.createdAt.toISOString()}</p>
        <p>Owner {users.find((user) => user.id === document.ownerUserId)?.name ?? '—'}</p>
        <p>Effective {document.effectiveDate?.toISOString().slice(0, 10) ?? '—'}</p>
        <p>Expires {document.expiryDate?.toISOString().slice(0, 10) ?? '—'}</p>
        <p>Last indexed {current?.indexedAt?.toISOString() ?? '—'}</p>
        <p>Chunk count {chunks}</p>
        <p>Embedding model {embedding?.embeddingModel ?? '—'}</p>
        <p>Freshness {freshness}</p>
      </article>
      <article className="panel">
        <h2>Processing</h2>
        <p>{stageLabel[current?.processingStatus ?? versions[0]?.processingStatus ?? 'pending'] ?? 'Uploaded'}</p>
        {versions[0]?.processingStatus === 'failed' ? <p>{versions[0].processingErrorSafe}</p> : null}
      </article>
      <article className="panel">
        <h2>Versions</h2>
        <ul>
          {versions.map((version) => (
            <li key={version.id}>
              v{version.versionNumber} · {stageLabel[version.processingStatus] ?? version.processingStatus}
              {version.id === document.currentVersionId ? ' · current' : ''}
              {version.processingStatus === 'ready' ? (
                <form action={reindexKnowledgeDocument}>
                  <input type="hidden" name="document_id" value={document.id} />
                  <input type="hidden" name="version_id" value={version.id} />
                  <button className="secondary" type="submit">Reindex current version</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {document.status !== 'archived' ? (
          <form action={archiveKnowledgeDocument}>
            <input type="hidden" name="document_id" value={document.id} />
            <button className="secondary" type="submit">Archive</button>
          </form>
        ) : <p className="muted">Archived documents are excluded from retrieval.</p>}
      </article>
      <article className="panel">
        <h2>AI systems with access through this space</h2>
        <ul>
          {grants.map((grant) => <li key={grant.id}>{systems.find((system) => system.id === grant.aiSystemId)?.name ?? grant.aiSystemId}</li>)}
        </ul>
      </article>
      <article className="panel">
        <h2>Audit history</h2>
        <ul>
          {audits.filter((event) => event.resourceId === document.id || event.metadataJson.document_id === document.id).slice(0, 20).map((event) => (
            <li key={event.id}>{event.action} · {event.result}</li>
          ))}
        </ul>
      </article>
    </>
  );
}
