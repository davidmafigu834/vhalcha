export interface KnowledgeCitation {
  citationId: string;
  documentId: string;
  documentVersionId: string;
  documentTitle: string;
  knowledgeSpaceId: string;
  knowledgeSpaceName: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  chunkIndex: number;
  chunkId: string;
  similarity: number;
}

const citationPattern = /\[S(\d+)\]/g;

export function selectCitedSources(answer: string, provided: KnowledgeCitation[]): KnowledgeCitation[] {
  const allowed = new Set(provided.map((citation) => citation.citationId));
  const used = new Set<string>();
  for (const match of answer.matchAll(citationPattern)) {
    const citationId = `S${match[1]}`;
    if (allowed.has(citationId)) {
      used.add(citationId);
    }
  }
  return provided.filter((citation) => used.has(citation.citationId));
}
