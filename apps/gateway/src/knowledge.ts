import { auditActions } from '@vhalcha/audit';
import { createKnowledgeRepository, createRepositories } from '@vhalcha/database';
import {
  INSUFFICIENT_KNOWLEDGE_MESSAGE,
  buildKnowledgeContext,
  createEmbeddingProvider,
  embeddingModeFromEnv,
  knowledgeLimits,
  selectCitedSources,
  type EmbeddingProvider,
  type KnowledgeCitation,
} from '@vhalcha/knowledge';
import { GatewayError } from '@vhalcha/types';
import type { GatewayDeps, PreparedChat } from './pipeline';

export interface GatewayKnowledge {
  used: boolean;
  insufficient: boolean;
  citations: KnowledgeCitation[];
  retrieved: KnowledgeCitation[];
  traces: Array<{
    knowledgeSpaceId: string;
    documentId: string;
    documentVersionId: string;
    chunkId: string;
    rank: number;
    similarity: number;
  }>;
}

export function knowledgeExtension(knowledge: GatewayKnowledge | undefined, answer: string) {
  if (!knowledge) {
    return undefined;
  }
  const citations = selectCitedSources(answer, knowledge.retrieved).map((citation) => ({
    citation_id: citation.citationId,
    document_id: citation.documentId,
    document_version_id: citation.documentVersionId,
    document_title: citation.documentTitle,
    knowledge_space: citation.knowledgeSpaceName,
    page_number: citation.pageNumber,
    section_title: citation.sectionTitle,
    chunk_index: citation.chunkIndex,
  }));
  return {
    used: knowledge.used,
    evidence: knowledge.insufficient ? 'insufficient' : knowledge.retrieved.length > 0 ? 'retrieved' : 'none',
    citations,
  };
}

export async function attachKnowledge(deps: GatewayDeps, prepared: PreparedChat, embedder?: EmbeddingProvider) {
  const system = await createRepositories(deps.db).aiSystems.findById(prepared.organisationId, prepared.aiSystemId);
  if (!system?.knowledgeEnabled) {
    return;
  }
  const provider =
    embedder ??
    deps.embedder ??
    createEmbeddingProvider({
      mode: embeddingModeFromEnv(),
      apiKey: deps.openAiApiKey,
    });
  const latestUser = [...prepared.body.messages].reverse().find((message) => message.role === 'user');
  const query = latestUser?.content ?? '';
  let retrieved;
  try {
    const queryVector = await provider.embedQuery(query);
    retrieved = await createKnowledgeRepository(deps.db).retrieve({
      organisationId: prepared.organisationId,
      aiSystemId: prepared.aiSystemId,
      queryVector,
      embeddingModel: provider.model,
      topK: system.knowledgeTopK,
      minimumSimilarity: Number(system.minimumSimilarity),
      strictGrounding: system.strictGrounding,
      allowStale: system.knowledgeAllowStale,
      requestedSpaceIds: prepared.body.knowledge_space_ids,
    });
  } catch (error) {
    deps.logger.info(
      {
        request_id: prepared.requestId,
        organisation_id: prepared.organisationId,
        ai_system_id: prepared.aiSystemId,
        event: 'knowledge_unavailable',
        error_name: error instanceof Error ? error.name : 'Error',
      },
      'knowledge retrieval failed',
    );
    await createRepositories(deps.db).audit.create(prepared.organisationId, {
      organisationId: prepared.organisationId,
      environmentId: prepared.environmentId,
      actorType: 'ai_system',
      actorId: prepared.aiSystemId,
      action: auditActions.knowledgeRetrievalFailed,
      resourceType: 'ai_system',
      resourceId: prepared.aiSystemId,
      requestId: prepared.requestId,
      result: 'failure',
      severity: 'warning',
      metadata: { ai_system_id: prepared.aiSystemId, error_code: 'knowledge_unavailable' },
    });
    throw new GatewayError('knowledge_unavailable', 'Approved company knowledge is unavailable for this request.');
  }
  const limited: typeof retrieved = [];
  let tokens = 0;
  for (const row of retrieved) {
    if (tokens + row.tokenCount > knowledgeLimits.maxRetrievedTokens) {
      break;
    }
    limited.push(row);
    tokens += row.tokenCount;
  }
  if (limited.length === 0 && system.strictGrounding) {
    prepared.knowledge = { used: false, insufficient: true, citations: [], retrieved: [], traces: [] };
    return;
  }
  if (limited.length === 0) {
    prepared.knowledge = { used: false, insufficient: false, citations: [], retrieved: [], traces: [] };
    return;
  }
  const context = buildKnowledgeContext({
    strictGrounding: system.strictGrounding,
    citations: limited.map((row) => row.citation),
    chunks: limited.map((row) => ({ citationId: row.citation.citationId, content: row.content })),
  });
  prepared.body = {
    ...prepared.body,
    messages: [{ role: 'system', content: context.text }, ...prepared.body.messages],
  };
  prepared.knowledge = {
    used: true,
    insufficient: false,
    citations: limited.map((row) => row.citation),
    retrieved: limited.map((row) => row.citation),
    traces: limited.map((row, index) => ({
      knowledgeSpaceId: row.citation.knowledgeSpaceId,
      documentId: row.citation.documentId,
      documentVersionId: row.citation.documentVersionId,
      chunkId: row.citation.chunkId,
      rank: index + 1,
      similarity: row.citation.similarity,
    })),
  };
}

export async function recordKnowledgeUse(deps: GatewayDeps, prepared: PreparedChat) {
  if (!prepared.knowledge || prepared.knowledge.traces.length === 0) {
    return;
  }
  await createKnowledgeRepository(deps.db).recordRetrieval(
    prepared.organisationId,
    prepared.knowledge.traces.map((trace) => ({
      requestId: prepared.requestId,
      aiSystemId: prepared.aiSystemId,
      knowledgeSpaceId: trace.knowledgeSpaceId,
      documentId: trace.documentId,
      documentVersionId: trace.documentVersionId,
      chunkId: trace.chunkId,
      rank: trace.rank,
      similarity: trace.similarity,
    })),
  );
}

export async function recordInsufficientKnowledge(deps: GatewayDeps, prepared: PreparedChat) {
  const repos = createRepositories(deps.db);
  await repos.requests.create({
    id: prepared.requestId,
    organisationId: prepared.organisationId,
    aiSystemId: prepared.aiSystemId,
    environmentId: prepared.environmentId,
    virtualApiKeyId: prepared.virtualApiKeyId,
    provider: prepared.provider,
    model: prepared.body.model,
    status: 'succeeded',
    policyResult: prepared.policyResult,
    startedAt: prepared.startedAt,
    httpStatus: 200,
    completedAt: new Date(),
  });
  await repos.audit.create(prepared.organisationId, {
    organisationId: prepared.organisationId,
    environmentId: prepared.environmentId,
    actorType: 'ai_system',
    actorId: prepared.aiSystemId,
    action: auditActions.knowledgeEvidenceInsufficient,
    resourceType: 'request',
    resourceId: prepared.requestId,
    requestId: prepared.requestId,
    result: 'success',
    severity: 'info',
    metadata: { ai_system_id: prepared.aiSystemId, evidence: 'insufficient' },
  });
}

export function insufficientKnowledgeBody(requestId: string) {
  return {
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: INSUFFICIENT_KNOWLEDGE_MESSAGE },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    vhalcha: {
      knowledge: {
        used: false,
        evidence: 'insufficient',
        citations: [],
      },
    },
  };
}

export { INSUFFICIENT_KNOWLEDGE_MESSAGE };
