import Link from 'next/link';
import { createKnowledgeRepository, createRepositories } from '@vhalcha/database';
import { documentFreshness } from '@vhalcha/knowledge';
import { AccessDenied } from '../../../../../components/access-denied';
import { getServices, requirePageAccess } from '../../../../../server/services';
import { grantKnowledgeAccess, revokeKnowledgeAccess, updateKnowledgeSettings, uploadKnowledgeFile, uploadKnowledgeText } from '../../../../../server/knowledge-actions';

export const metadata = { title: 'Knowledge Space' };

export default async function KnowledgeSpacePage({
  params,
  searchParams,
}: {
  params: Promise<{ spaceId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const access = await requirePageAccess('knowledge:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const { spaceId } = await params;
  const { tab = 'documents' } = await searchParams;
  const organisationId = access.claims.oid;
  const db = getServices().db;
  const knowledge = createKnowledgeRepository(db);
  const repos = createRepositories(db);
  const space = await knowledge.getSpace(organisationId, spaceId);
  if (!space) return <p className="empty">This knowledge space is not available.</p>;
  const [documents, sources, grants, systems, audits, users] = await Promise.all([
    knowledge.listDocuments(organisationId, spaceId),
    knowledge.listSources(organisationId, spaceId),
    knowledge.listAccessForSpace(organisationId, spaceId),
    repos.aiSystems.list(organisationId),
    repos.audit.list(organisationId),
    repos.users.list(organisationId),
  ]);
  const owner = users.find((user) => user.id === space.ownerUserId);
  const tabs = [
    ['documents', 'Documents'],
    ['sources', 'Sources'],
    ['access', 'AI Access'],
    ['settings', 'Settings'],
    ['audit', 'Audit'],
  ] as const;
  return (
    <>
      <h1 className="page-title">{space.name}</h1>
      <p>{space.description || 'No description.'}</p>
      <p className="muted">Owner {owner?.name ?? '—'} · {space.status} · freshness {space.defaultFreshnessDays ? `${space.defaultFreshnessDays} days` : 'not set'}</p>
      <nav>
        {tabs.map(([id, label]) => (
          <Link key={id} href={`/knowledge/spaces/${spaceId}?tab=${id}`} aria-current={tab === id ? 'page' : undefined}>{label}</Link>
        ))}
      </nav>
      {tab === 'documents' ? (
        <article className="panel">
          <ul>
            {documents.map((document) => (
              <li key={document.id}>
                <Link href={`/knowledge/documents/${document.id}`}>{document.title}</Link>
                <span className="muted"> · {document.status} · {documentFreshness({
                  status: document.status,
                  expiryDate: document.expiryDate,
                  indexedAt: null,
                  freshnessDays: space.defaultFreshnessDays,
                })}</span>
              </li>
            ))}
          </ul>
          {documents.length === 0 ? <p className="empty">No documents in this space.</p> : null}
          <h2>Upload text</h2>
          <form action={uploadKnowledgeText}>
            <input type="hidden" name="space_id" value={space.id} />
            <label>Title <input name="title" required /></label>
            <label>Text <textarea name="text" required /></label>
            <label>Effective <input name="effective_date" type="date" /></label>
            <label>Expires <input name="expiry_date" type="date" /></label>
            <button type="submit">Upload</button>
          </form>
          <h2>Upload file</h2>
          <form action={uploadKnowledgeFile}>
            <input type="hidden" name="space_id" value={space.id} />
            <label>Title <input name="title" required /></label>
            <label>File <input name="file" type="file" required /></label>
            <label>Effective <input name="effective_date" type="date" /></label>
            <label>Expires <input name="expiry_date" type="date" /></label>
            <button type="submit">Upload</button>
          </form>
          <p className="muted">Indexing runs in the worker. This page does not mark a document ready at upload time.</p>
        </article>
      ) : null}
      {tab === 'sources' ? (
        <article className="panel">
          <ul>
            {sources.map((source) => (
              <li key={source.id}>{source.name} · {source.sourceType} · {source.status}</li>
            ))}
          </ul>
          {sources.length === 0 ? <p className="empty">No sources yet. V1 supports manual text and file upload.</p> : null}
        </article>
      ) : null}
      {tab === 'access' ? (
        <article className="panel">
          <ul>
            {grants.map((grant) => (
              <li key={grant.id}>
                {systems.find((system) => system.id === grant.aiSystemId)?.name ?? grant.aiSystemId} · {grant.accessLevel}
                <form action={revokeKnowledgeAccess}>
                  <input type="hidden" name="space_id" value={space.id} />
                  <input type="hidden" name="ai_system_id" value={grant.aiSystemId} />
                  <button className="secondary" type="submit">Revoke</button>
                </form>
              </li>
            ))}
          </ul>
          <form action={grantKnowledgeAccess}>
            <input type="hidden" name="space_id" value={space.id} />
            <label>AI system
              <select name="ai_system_id">
                {systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
              </select>
            </label>
            <button type="submit">Grant read access</button>
          </form>
        </article>
      ) : null}
      {tab === 'settings' ? (
        <article className="panel">
          <form action={updateKnowledgeSettings}>
            <input type="hidden" name="space_id" value={space.id} />
            <label>Description <input name="description" defaultValue={space.description} /></label>
            <label>Freshness days <input name="freshness_days" type="number" min={1} defaultValue={space.defaultFreshnessDays ?? ''} /></label>
            <button type="submit">Save settings</button>
          </form>
        </article>
      ) : null}
      {tab === 'audit' ? (
        <article className="panel">
          <ul>
            {audits.filter((event) => String(event.metadataJson.knowledge_space_id ?? '') === space.id || event.resourceId === space.id).slice(0, 30).map((event) => (
              <li key={event.id}>{event.action} · {event.result}</li>
            ))}
          </ul>
        </article>
      ) : null}
    </>
  );
}
