import Link from 'next/link';
import { createKnowledgeRepository, createRepositories } from '@vhalcha/database';
import { documentFreshness } from '@vhalcha/knowledge';
import { AccessDenied } from '../../../components/access-denied';
import { getServices, requirePageAccess } from '../../../server/services';
import { updateSystemKnowledge } from '../../../server/knowledge-actions';

export const metadata = { title: 'Knowledge' };

export default async function KnowledgeOverviewPage() {
  const access = await requirePageAccess('knowledge:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const organisationId = access.claims.oid;
  const db = getServices().db;
  const knowledge = createKnowledgeRepository(db);
  const repos = createRepositories(db);
  const [spaces, documents, systems] = await Promise.all([
    knowledge.listSpaces(organisationId),
    knowledge.listDocuments(organisationId),
    repos.aiSystems.list(organisationId),
  ]);
  const versions = await Promise.all(documents.map((document) => knowledge.listVersions(organisationId, document.id)));
  const currentVersions = new Map(
    documents.map((document, index) => [
      document.id,
      versions[index]?.find((version) => version.id === document.currentVersionId) ?? versions[index]?.[0],
    ]),
  );
  const spaceById = new Map(spaces.map((space) => [space.id, space]));
  const freshnessOf = (documentId: string) => {
    const document = documents.find((row) => row.id === documentId);
    const version = currentVersions.get(documentId);
    if (!document) return 'failed' as const;
    return documentFreshness({
      status: document.status,
      expiryDate: document.expiryDate,
      indexedAt: version?.indexedAt ?? null,
      freshnessDays: spaceById.get(document.knowledgeSpaceId)?.defaultFreshnessDays ?? null,
    });
  };
  const ready = documents.filter((document) => document.status === 'ready').length;
  const processing = documents.filter((document) => document.status === 'processing').length;
  const failed = documents.filter((document) => document.status === 'failed').length;
  const stale = documents.filter((document) => freshnessOf(document.id) === 'stale' || freshnessOf(document.id) === 'expired').length;
  const usingKnowledge = systems.filter((system) => system.knowledgeEnabled);
  return (
    <>
      <h1 className="page-title">Knowledge</h1>
      <p className="muted">Governed company information that approved AI systems can retrieve.</p>
      <section className="grid-4">
        <article className="metric"><span>Knowledge Spaces</span><strong>{spaces.filter((space) => space.status === 'active').length}</strong></article>
        <article className="metric"><span>Documents</span><strong>{documents.length}</strong></article>
        <article className="metric"><span>Ready</span><strong>{ready}</strong></article>
        <article className="metric"><span>Needs Attention</span><strong>{failed + stale}</strong></article>
      </section>
      <section className="grid-2">
        <article className="panel">
          <h2>Recently Updated</h2>
          {documents.length === 0 ? <p className="empty">No documents yet.</p> : (
            <ul>
              {documents.slice(0, 8).map((document) => (
                <li key={document.id}>
                  <Link href={`/knowledge/documents/${document.id}`}>{document.title}</Link>
                  <div className="muted">{document.status} · {freshnessOf(document.id)}</div>
                </li>
              ))}
            </ul>
          )}
        </article>
        <article className="panel">
          <h2>Processing</h2>
          <p className="muted">{processing} processing · {failed} failed</p>
          {documents.filter((document) => document.status === 'processing' || document.status === 'failed').length === 0 ? (
            <p className="empty">No documents are waiting.</p>
          ) : (
            <ul>
              {documents.filter((document) => document.status === 'processing' || document.status === 'failed').map((document) => (
                <li key={document.id}><Link href={`/knowledge/documents/${document.id}`}>{document.title}</Link> · {document.status}</li>
              ))}
            </ul>
          )}
        </article>
      </section>
      <article className="panel">
        <h2>AI Systems Using Knowledge</h2>
        {usingKnowledge.length === 0 ? <p className="empty">Knowledge is off for every AI system. Existing systems stay off until you enable them.</p> : (
          <ul>
            {usingKnowledge.map((system) => (
              <li key={system.id}>{system.name} · top {system.knowledgeTopK} · {system.strictGrounding ? 'strict grounding' : 'grounding optional'}</li>
            ))}
          </ul>
        )}
        <form action={updateSystemKnowledge}>
          <label>AI system
            <select name="ai_system_id">
              {systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
            </select>
          </label>
          <label><input name="knowledge_enabled" type="checkbox" /> Knowledge enabled</label>
          <label><input name="strict_grounding" type="checkbox" /> Strict grounding</label>
          <label><input name="allow_stale" type="checkbox" /> Allow stale when strict grounding is off</label>
          <label>Top K <input name="top_k" type="number" min={1} max={20} defaultValue={6} /></label>
          <label>Minimum similarity <input name="minimum_similarity" type="number" min={0} max={1} step="0.05" defaultValue={0.2} /></label>
          <button type="submit">Save AI system knowledge</button>
        </form>
      </article>
      <p><Link href="/knowledge/spaces">Open Knowledge Spaces</Link></p>
    </>
  );
}
