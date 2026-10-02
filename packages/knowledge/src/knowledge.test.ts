import { describe, expect, it } from 'vitest';
import { selectCitedSources } from './citations';
import { chunkText } from './chunk';
import { deterministicEmbedding } from './embeddings';
import { extractDocument } from './extract';
import { documentFreshness, retrievalAllowsFreshness } from './freshness';
import { buildKnowledgeContext } from './grounding';
import { assertObjectTenant, MemoryKnowledgeObjectStore } from './storage';

describe('knowledge primitives', () => {
  it('chunks text without dropping the document', () => {
    const text = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} explains the returns policy.`).join(
      '\n\n',
    );
    const chunks = chunkText(text, { targetTokens: 40, overlapRatio: 0.1 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.chunkIndex).toBe(0);
    expect(new Set(chunks.map((chunk) => chunk.chunkIndex)).size).toBe(chunks.length);
  });

  it('embeds the same text to the same vector', () => {
    const left = deterministicEmbedding('returns policy for damaged goods');
    const right = deterministicEmbedding('returns policy for damaged goods');
    expect(left).toEqual(right);
    expect(left).toHaveLength(1536);
  });

  it('keeps only citations that were actually retrieved', () => {
    const provided = [
      citation('S1'),
      citation('S2'),
    ];
    expect(selectCitedSources('See [S1] and [S3].', provided).map((item) => item.citationId)).toEqual(['S1']);
  });

  it('blocks expired and stale knowledge according to policy', () => {
    const expired = documentFreshness({
      status: 'ready',
      expiryDate: new Date('2020-01-01'),
      indexedAt: new Date(),
      freshnessDays: 30,
      now: new Date('2026-01-01'),
    });
    expect(expired).toBe('expired');
    expect(retrievalAllowsFreshness('expired', { strictGrounding: true, allowStale: true })).toBe(false);
    expect(retrievalAllowsFreshness('stale', { strictGrounding: true, allowStale: true })).toBe(false);
    expect(retrievalAllowsFreshness('stale', { strictGrounding: false, allowStale: true })).toBe(true);
  });

  it('refuses another organisation object key', async () => {
    const store = new MemoryKnowledgeObjectStore();
    const key = await store.put({
      organisationId: 'org-a',
      documentId: 'doc',
      versionId: 'ver',
      bytes: Buffer.from('secret'),
    });
    await expect(store.get('org-b', key)).rejects.toThrow(/forbidden/);
    expect(() => assertObjectTenant('org-a', 'knowledge/org-b/doc/ver/original')).toThrow(/forbidden/);
  });

  it('extracts plain text and rejects an empty scanned-style pdf marker', async () => {
    const extracted = await extractDocument({ mimeType: 'text/plain', buffer: Buffer.from('Returns are accepted.') });
    expect(extracted.text).toContain('Returns');
    const context = buildKnowledgeContext({
      strictGrounding: true,
      citations: [citation('S1')],
      chunks: [{ citationId: 'S1', content: 'Returns are accepted.' }],
    });
    expect(context.text).toContain('reference information');
    expect(context.text).toContain('[S1]');
  });
});

function citation(citationId: string) {
  return {
    citationId,
    documentId: 'doc',
    documentVersionId: 'ver',
    documentTitle: 'Returns Policy',
    knowledgeSpaceId: 'space',
    knowledgeSpaceName: 'Support',
    pageNumber: 1,
    sectionTitle: null,
    chunkIndex: 0,
    chunkId: 'chunk',
    similarity: 0.9,
  };
}
