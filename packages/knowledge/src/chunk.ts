import { createHash } from 'node:crypto';
import { knowledgeLimits } from './limits';

export interface TextChunk {
  chunkIndex: number;
  content: string;
  tokenCount: number;
  pageNumber: number | null;
  sectionTitle: string | null;
  contentHash: string;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function contentHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function chunkText(
  text: string,
  options?: { targetTokens?: number; overlapRatio?: number; pageNumber?: number | null },
): TextChunk[] {
  const targetTokens = options?.targetTokens ?? knowledgeLimits.chunkTargetTokens;
  const overlapRatio = options?.overlapRatio ?? knowledgeLimits.chunkOverlapRatio;
  const targetCharacters = targetTokens * 4;
  const overlapCharacters = Math.floor(targetCharacters * overlapRatio);
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const chunks: TextChunk[] = [];
  let buffer = '';
  let sectionTitle: string | null = null;
  const flush = () => {
    const content = buffer.trim();
    if (!content) {
      return;
    }
    chunks.push({
      chunkIndex: chunks.length,
      content,
      tokenCount: estimateTokens(content),
      pageNumber: options?.pageNumber ?? null,
      sectionTitle,
      contentHash: contentHash(content),
    });
  };
  for (const block of blocks.length > 0 ? blocks : [text.trim()]) {
    const heading = block.match(/^#{1,3}\s+(.+)$/m);
    if (heading?.[1]) {
      sectionTitle = heading[1].trim();
    }
    if (estimateTokens(buffer) + estimateTokens(block) > targetTokens && buffer.trim()) {
      flush();
      buffer = overlapCharacters > 0 ? buffer.slice(-overlapCharacters) : '';
    }
    buffer = `${buffer}\n\n${block}`.trim();
    if (buffer.length >= targetCharacters) {
      flush();
      buffer = overlapCharacters > 0 ? buffer.slice(-overlapCharacters) : '';
    }
  }
  flush();
  return chunks.filter((chunk) => chunk.content.length > 0);
}
