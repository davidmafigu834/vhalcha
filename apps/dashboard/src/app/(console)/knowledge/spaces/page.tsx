import Link from 'next/link';
import { createKnowledgeRepository, createRepositories } from '@vhalcha/database';
import { AccessDenied } from '../../../../components/access-denied';
import { getServices, requirePageAccess } from '../../../../server/services';
import { archiveKnowledgeSpace, createKnowledgeSpace } from '../../../../server/knowledge-actions';

export const metadata = { title: 'Knowledge Spaces' };

export default async function KnowledgeSpacesPage() {
  const access = await requirePageAccess('knowledge:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const organisationId = access.claims.oid;
  const knowledge = createKnowledgeRepository(getServices().db);
  const repos = createRepositories(getServices().db);
  const [spaces, documents, systems, users] = await Promise.all([
    knowledge.listSpaces(organisationId),
    knowledge.listDocuments(organisationId),
    repos.aiSystems.list(organisationId),
    repos.users.list(organisationId),
  ]);
  const accessRows = await Promise.all(spaces.map((space) => knowledge.listAccessForSpace(organisationId, space.id)));
  return (
    <>
      <h1 className="page-title">Knowledge Spaces</h1>
      <article className="panel">
        <table>
          <thead>
            <tr><th>Name</th><th>Owner</th><th>Documents</th><th>AI Systems</th><th>Freshness</th><th>Status</th><th>Updated</th><th></th></tr>
          </thead>
          <tbody>
            {spaces.map((space, index) => (
              <tr key={space.id}>
                <td><Link href={`/knowledge/spaces/${space.id}`}>{space.name}</Link></td>
                <td>{users.find((user) => user.id === space.ownerUserId)?.name ?? '—'}</td>
                <td>{documents.filter((document) => document.knowledgeSpaceId === space.id).length}</td>
                <td>{accessRows[index]?.length ?? 0}</td>
                <td>{space.defaultFreshnessDays ? `${space.defaultFreshnessDays} days` : 'No age rule'}</td>
                <td>{space.status}</td>
                <td>{space.updatedAt.toISOString().slice(0, 10)}</td>
                <td>
                  <Link href={`/knowledge/spaces/${space.id}`}>Open</Link>
                  {space.status === 'active' ? (
                    <form action={archiveKnowledgeSpace}>
                      <input type="hidden" name="space_id" value={space.id} />
                      <button className="secondary" type="submit">Archive</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {spaces.length === 0 ? <p className="empty">No knowledge spaces yet.</p> : null}
      </article>
      <article className="panel">
        <h2>Create space</h2>
        <form action={createKnowledgeSpace}>
          <label>Name <input name="name" required /></label>
          <label>Description <input name="description" /></label>
          <label>Freshness days <input name="freshness_days" type="number" min={1} /></label>
          <button type="submit">Create space</button>
        </form>
        <p className="muted">{systems.length} AI systems in this organisation. Access is granted per space.</p>
      </article>
    </>
  );
}
