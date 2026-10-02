import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const embeddingVector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(1536)';
  },
  toDriver(value: number[]) {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string) {
    return value
      .replace('[', '')
      .replace(']', '')
      .split(',')
      .filter((part) => part.length > 0)
      .map(Number);
  },
});

function createdAt() {
  return timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
}

export const organisations = pgTable('organisations', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  status: text('status').notNull(),
  defaultCurrency: text('default_currency').notNull().default('USD'),
  timezone: text('timezone').notNull().default('UTC'),
  contentLoggingMode: text('content_logging_mode').notNull().default('metadata_only'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull(),
    passwordHash: text('password_hash'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_org_email_unique').on(table.organisationId, table.email),
    index('users_organisation_idx').on(table.organisationId),
  ],
);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const environments = pgTable(
  'environments',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    type: text('type').notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('environments_org_slug_unique').on(table.organisationId, table.slug)],
);

export const aiSystems = pgTable(
  'ai_systems',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    type: text('type').notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id),
    status: text('status').notNull(),
    riskLevel: text('risk_level').notNull(),
    monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 14, scale: 6 }),
    dailyBudgetUsd: numeric('daily_budget_usd', { precision: 14, scale: 6 }),
    requestsPerMinute: integer('requests_per_minute').notNull().default(60),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    knowledgeEnabled: boolean('knowledge_enabled').notNull().default(false),
    strictGrounding: boolean('strict_grounding').notNull().default(false),
    knowledgeTopK: integer('knowledge_top_k').notNull().default(6),
    minimumSimilarity: numeric('minimum_similarity', { precision: 6, scale: 5 }).notNull().default('0.20000'),
    knowledgeAllowStale: boolean('knowledge_allow_stale').notNull().default(false),
    routingMode: text('routing_mode').notNull().default('fixed'),
    routingStrategy: text('routing_strategy').notNull().default('balanced'),
    baselineModelId: uuid('baseline_model_id'),
    maxRequestCostUsd: numeric('max_request_cost_usd', { precision: 18, scale: 8 }),
    premiumEscalation: boolean('premium_escalation').notNull().default(false),
    fallbackEnabled: boolean('fallback_enabled').notNull().default(true),
    maxProviderAttempts: integer('max_provider_attempts').notNull().default(2),
    routingConstraints: jsonb('routing_constraints').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [uniqueIndex('ai_systems_org_slug_unique').on(table.organisationId, table.slug)],
);

export const virtualApiKeys = pgTable('virtual_api_keys', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  aiSystemId: uuid('ai_system_id')
    .notNull()
    .references(() => aiSystems.id),
  environmentId: uuid('environment_id')
    .notNull()
    .references(() => environments.id),
  name: text('name').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  status: text('status').notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const providerConnections = pgTable('provider_connections', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  environmentId: uuid('environment_id')
    .notNull()
    .references(() => environments.id),
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  credentialSource: text('credential_source').notNull(),
  credentialRef: text('credential_ref'),
  encryptedCredentials: text('encrypted_credentials'),
  verificationStatus: text('verification_status').notNull().default('unverified'),
  verificationErrorCode: text('verification_error_code'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('provider_connections_one_active_idx')
    .on(table.organisationId, table.environmentId, table.provider)
    .where(sql`${table.status} = 'active'`),
]);

export const modelAccessRules = pgTable('model_access_rules', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  aiSystemId: uuid('ai_system_id')
    .notNull()
    .references(() => aiSystems.id),
  provider: text('provider').notNull(),
  modelPattern: text('model_pattern').notNull(),
  isAllowed: boolean('is_allowed').notNull(),
  priority: integer('priority').notNull().default(100),
  createdAt: createdAt(),
});

export const budgets = pgTable('budgets', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  aiSystemId: uuid('ai_system_id').references(() => aiSystems.id),
  environmentId: uuid('environment_id').references(() => environments.id),
  name: text('name').notNull(),
  period: text('period').notNull(),
  amountUsd: numeric('amount_usd', { precision: 14, scale: 6 }).notNull(),
  warningThresholdPercent: integer('warning_threshold_percent').notNull().default(80),
  hardLimit: boolean('hard_limit').notNull().default(false),
  action: text('action').notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const requests = pgTable('requests', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  aiSystemId: uuid('ai_system_id')
    .notNull()
    .references(() => aiSystems.id),
  environmentId: uuid('environment_id')
    .notNull()
    .references(() => environments.id),
  virtualApiKeyId: uuid('virtual_api_key_id')
    .notNull()
    .references(() => virtualApiKeys.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  status: text('status').notNull(),
  httpStatus: integer('http_status'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  totalTokens: integer('total_tokens'),
  estimatedCostUsd: numeric('estimated_cost_usd', { precision: 18, scale: 8 }),
  latencyMs: integer('latency_ms'),
  providerLatencyMs: integer('provider_latency_ms'),
  timeToFirstTokenMs: integer('time_to_first_token_ms'),
  policyResult: text('policy_result').notNull(),
  errorCode: text('error_code'),
  errorMessageSafe: text('error_message_safe'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    aiSystemId: uuid('ai_system_id')
      .notNull()
      .references(() => aiSystems.id),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    costUsd: numeric('cost_usd', { precision: 18, scale: 8 }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('usage_events_request_id_uidx').on(table.requestId)],
);

export const budgetReservations = pgTable(
  'budget_reservations',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    aiSystemId: uuid('ai_system_id')
      .notNull()
      .references(() => aiSystems.id),
    requestId: uuid('request_id').notNull(),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id),
    reservedUsd: numeric('reserved_usd', { precision: 18, scale: 8 }).notNull(),
    actualUsd: numeric('actual_usd', { precision: 18, scale: 8 }),
    status: text('status').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('budget_reservations_request_budget_uidx').on(table.requestId, table.budgetId),
    index('budget_reservations_hold_idx').on(table.budgetId, table.status, table.expiresAt),
  ],
);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  environmentId: uuid('environment_id').references(() => environments.id),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  result: text('result').notNull(),
  severity: text('severity').notNull(),
  requestId: uuid('request_id'),
  metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const policyEvents = pgTable('policy_events', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  aiSystemId: uuid('ai_system_id')
    .notNull()
    .references(() => aiSystems.id),
  requestId: uuid('request_id'),
  policyType: text('policy_type').notNull(),
  policyName: text('policy_name').notNull(),
  result: text('result').notNull(),
  severity: text('severity').notNull(),
  detailsJson: jsonb('details_json').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const spendSummaries = pgTable(
  'spend_summaries',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    aiSystemId: uuid('ai_system_id')
      .notNull()
      .references(() => aiSystems.id),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    period: text('period').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    totalCostUsd: numeric('total_cost_usd', { precision: 18, scale: 8 }).notNull().default('0'),
    totalRequests: integer('total_requests').notNull().default(0),
    totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('spend_summaries_identity').on(
      table.organisationId,
      table.aiSystemId,
      table.provider,
      table.model,
      table.period,
      table.periodStart,
    ),
  ],
);

export const knowledgeSpaces = pgTable(
  'knowledge_spaces',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id),
    defaultFreshnessDays: integer('default_freshness_days'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('knowledge_spaces_org_slug_unique').on(table.organisationId, table.slug)],
);

export const knowledgeSources = pgTable('knowledge_sources', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  knowledgeSpaceId: uuid('knowledge_space_id')
    .notNull()
    .references(() => knowledgeSpaces.id),
  name: text('name').notNull(),
  sourceType: text('source_type').notNull(),
  status: text('status').notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSuccessfulSyncAt: timestamp('last_successful_sync_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  lastErrorSafe: text('last_error_safe'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeDocuments = pgTable('knowledge_documents', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  knowledgeSpaceId: uuid('knowledge_space_id')
    .notNull()
    .references(() => knowledgeSpaces.id),
  knowledgeSourceId: uuid('knowledge_source_id').references(() => knowledgeSources.id),
  title: text('title').notNull(),
  description: text('description'),
  documentType: text('document_type').notNull(),
  mimeType: text('mime_type'),
  status: text('status').notNull(),
  currentVersionId: uuid('current_version_id'),
  ownerUserId: uuid('owner_user_id').references(() => users.id),
  effectiveDate: timestamp('effective_date', { withTimezone: true }),
  expiryDate: timestamp('expiry_date', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});

export const knowledgeDocumentVersions = pgTable(
  'knowledge_document_versions',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id),
    versionNumber: integer('version_number').notNull(),
    storageKey: text('storage_key'),
    originalFilename: text('original_filename'),
    mimeType: text('mime_type'),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
    contentHash: text('content_hash').notNull(),
    extractedText: text('extracted_text'),
    processingStatus: text('processing_status').notNull(),
    processingErrorCode: text('processing_error_code'),
    processingErrorSafe: text('processing_error_safe'),
    ingestAttempts: integer('ingest_attempts').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('knowledge_document_versions_number_unique').on(table.documentId, table.versionNumber)],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    knowledgeSpaceId: uuid('knowledge_space_id')
      .notNull()
      .references(() => knowledgeSpaces.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id),
    documentVersionId: uuid('document_version_id')
      .notNull()
      .references(() => knowledgeDocumentVersions.id),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),
    pageNumber: integer('page_number'),
    sectionTitle: text('section_title'),
    contentHash: text('content_hash').notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('knowledge_chunks_version_index_unique').on(table.documentVersionId, table.chunkIndex)],
);

export const knowledgeChunkEmbeddings = pgTable(
  'knowledge_chunk_embeddings',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => knowledgeChunks.id),
    embeddingModel: text('embedding_model').notNull(),
    embeddingDimensions: integer('embedding_dimensions').notNull(),
    embedding: embeddingVector('embedding').notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('knowledge_chunk_embeddings_model_unique').on(table.chunkId, table.embeddingModel)],
);

export const aiSystemKnowledgeAccess = pgTable(
  'ai_system_knowledge_access',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    aiSystemId: uuid('ai_system_id')
      .notNull()
      .references(() => aiSystems.id),
    knowledgeSpaceId: uuid('knowledge_space_id')
      .notNull()
      .references(() => knowledgeSpaces.id),
    accessLevel: text('access_level').notNull(),
    createdAt: createdAt(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
  },
  (table) => [uniqueIndex('ai_system_knowledge_access_unique').on(table.aiSystemId, table.knowledgeSpaceId)],
);

export const knowledgeRetrievalEvents = pgTable('knowledge_retrieval_events', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  requestId: uuid('request_id').notNull(),
  aiSystemId: uuid('ai_system_id')
    .notNull()
    .references(() => aiSystems.id),
  knowledgeSpaceId: uuid('knowledge_space_id')
    .notNull()
    .references(() => knowledgeSpaces.id),
  documentId: uuid('document_id')
    .notNull()
    .references(() => knowledgeDocuments.id),
  documentVersionId: uuid('document_version_id')
    .notNull()
    .references(() => knowledgeDocumentVersions.id),
  chunkId: uuid('chunk_id')
    .notNull()
    .references(() => knowledgeChunks.id),
  rank: integer('rank').notNull(),
  similarityScore: numeric('similarity_score', { precision: 8, scale: 6 }).notNull(),
  createdAt: createdAt(),
});

export const knowledgeIngestionUsage = pgTable('knowledge_ingestion_usage', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  documentId: uuid('document_id')
    .notNull()
    .references(() => knowledgeDocuments.id),
  documentVersionId: uuid('document_version_id')
    .notNull()
    .references(() => knowledgeDocumentVersions.id),
  embeddingProvider: text('embedding_provider').notNull(),
  embeddingModel: text('embedding_model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  estimatedCostUsd: numeric('estimated_cost_usd', { precision: 14, scale: 6 }).notNull(),
  createdAt: createdAt(),
});

export const modelCatalogue = pgTable(
  'model_catalogue',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    modelName: text('model_name').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull(),
    tier: text('tier').notNull(),
    inputUsdPerMillion: numeric('input_usd_per_million', { precision: 14, scale: 6 }).notNull(),
    outputUsdPerMillion: numeric('output_usd_per_million', { precision: 14, scale: 6 }).notNull(),
    cachedInputUsdPerMillion: numeric('cached_input_usd_per_million', { precision: 14, scale: 6 }),
    contextWindow: integer('context_window').notNull(),
    maxOutputTokens: integer('max_output_tokens').notNull(),
    capabilities: jsonb('capabilities').$type<string[]>().notNull(),
    reasoningLevel: text('reasoning_level').notNull(),
    latencyClass: text('latency_class').notNull(),
    supportsTools: boolean('supports_tools').notNull().default(false),
    supportsVision: boolean('supports_vision').notNull().default(false),
    supportsStructuredOutput: boolean('supports_structured_output').notNull().default(false),
    supportsStreaming: boolean('supports_streaming').notNull().default(true),
    supportsEmbeddings: boolean('supports_embeddings').notNull().default(false),
    supportsLongContext: boolean('supports_long_context').notNull().default(false),
    currency: text('currency').notNull().default('USD'),
    priceEffectiveAt: timestamp('price_effective_at', { withTimezone: true }),
    priceVerifiedAt: timestamp('price_verified_at', { withTimezone: true }),
    priceSource: text('price_source'),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('model_catalogue_provider_model_unique').on(table.provider, table.modelName)],
);

export const organisationModelAccess = pgTable(
  'organisation_model_access',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    modelCatalogueId: uuid('model_catalogue_id')
      .notNull()
      .references(() => modelCatalogue.id),
    status: text('status').notNull(),
    tierOverride: text('tier_override'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('organisation_model_access_unique').on(table.organisationId, table.modelCatalogueId),
  ],
);

export const providerHealth = pgTable(
  'provider_health',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id),
    provider: text('provider').notNull(),
    modelName: text('model_name').notNull().default(''),
    status: text('status').notNull(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('provider_health_target_unique').on(
      table.organisationId,
      table.environmentId,
      table.provider,
      table.modelName,
    ),
  ],
);

export const routingDecisions = pgTable('routing_decisions', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  requestId: uuid('request_id')
    .notNull()
    .references(() => requests.id),
  aiSystemId: uuid('ai_system_id')
    .notNull()
    .references(() => aiSystems.id),
  routingMode: text('routing_mode').notNull(),
  routingStrategy: text('routing_strategy').notNull(),
  selectedProvider: text('selected_provider').notNull(),
  selectedModel: text('selected_model').notNull(),
  selectedModelId: uuid('selected_model_id').references(() => modelCatalogue.id),
  candidateCount: integer('candidate_count').notNull(),
  complexity: text('complexity').notNull(),
  risk: text('risk').notNull(),
  estimatedInputTokens: integer('estimated_input_tokens').notNull(),
  estimatedOutputTokens: integer('estimated_output_tokens').notNull(),
  estimatedSelectedCost: numeric('estimated_selected_cost', { precision: 18, scale: 8 }),
  estimatedBaselineCost: numeric('estimated_baseline_cost', { precision: 18, scale: 8 }),
  estimatedSavings: numeric('estimated_savings', { precision: 18, scale: 8 }),
  decisionReason: jsonb('decision_reason').$type<Record<string, unknown>>().notNull().default({}),
  fallbackFrom: text('fallback_from'),
  fallbackReason: text('fallback_reason'),
  createdAt: createdAt(),
});

export const requestProviderAttempts = pgTable(
  'request_provider_attempts',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id),
    routingDecisionId: uuid('routing_decision_id').references(() => routingDecisions.id),
    attemptNumber: integer('attempt_number').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 18, scale: 8 }),
    actualCostUsd: numeric('actual_cost_usd', { precision: 18, scale: 8 }),
    errorCode: text('error_code'),
    billable: boolean('billable').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('request_provider_attempts_request_attempt_uidx').on(table.organisationId, table.requestId, table.attemptNumber),
    index('request_provider_attempts_org_request_idx').on(table.organisationId, table.requestId),
  ],
);

export const guardSettings = pgTable('guard_settings', {
  id: uuid('id').primaryKey(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  mode: text('mode').notNull().default('monitor'),
  enforcementFailureMode: text('enforcement_failure_mode').notNull().default('fail_open'),
  retentionDays: integer('retention_days').notNull().default(90),
  auditLoggingEnabled: boolean('audit_logging_enabled').notNull().default(true),
  guardEnabled: boolean('guard_enabled').notNull().default(true),
  organisationLabel: text('organisation_label').notNull().default('standard'),
  policySetVersion: integer('policy_set_version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const guardSystemProfiles = pgTable(
  'guard_system_profiles',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    aiSystemId: uuid('ai_system_id')
      .notNull()
      .references(() => aiSystems.id),
    guardStatus: text('guard_status').notNull(),
    runtime: text('runtime').notNull(),
    dataAccess: jsonb('data_access').$type<string[]>().notNull().default([]),
    sensitiveDataUnrestricted: boolean('sensitive_data_unrestricted').notNull().default(false),
    overprivileged: boolean('overprivileged').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('guard_system_profiles_org_system_uidx').on(table.organisationId, table.aiSystemId),
    index('guard_system_profiles_org_idx').on(table.organisationId),
  ],
);

export const guardEvents = pgTable(
  'guard_events',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    aiSystemId: uuid('ai_system_id').references(() => aiSystems.id),
    environmentId: uuid('environment_id').references(() => environments.id),
    eventType: text('event_type').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    actionTaken: text('action_taken').notNull(),
    status: text('status').notNull().default('open'),
    provider: text('provider'),
    model: text('model'),
    runtime: text('runtime'),
    actorLabel: text('actor_label'),
    dataCategory: text('data_category'),
    policyName: text('policy_name'),
    policyId: uuid('policy_id'),
    policyVersion: integer('policy_version'),
    requestId: uuid('request_id').references(() => requests.id, { onDelete: 'set null' }),
    traceId: text('trace_id'),
    decisionId: text('decision_id'),
    evidenceJson: jsonb('evidence_json').$type<Record<string, unknown>>().notNull().default({}),
    metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('guard_events_org_time_idx').on(table.organisationId, table.occurredAt),
    index('guard_events_org_system_idx').on(table.organisationId, table.aiSystemId, table.occurredAt),
  ],
);

export const guardIncidents = pgTable(
  'guard_incidents',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    title: text('title').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull(),
    ownerUserId: uuid('owner_user_id').references(() => users.id),
    summary: text('summary').notNull().default(''),
    description: text('description').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: text('resolution'),
    followUp: text('follow_up'),
    displayNumber: integer('display_number').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('guard_incidents_org_status_idx').on(table.organisationId, table.status),
    uniqueIndex('guard_incidents_org_number_uidx').on(table.organisationId, table.displayNumber),
    index('guard_incidents_org_owner_idx').on(table.organisationId, table.ownerUserId),
    index('guard_incidents_org_updated_idx').on(table.organisationId, table.updatedAt),
  ],
);

export const guardDisplaySequences = pgTable(
  'guard_display_sequences',
  {
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    kind: text('kind').notNull(),
    lastValue: integer('last_value').notNull(),
  },
  (table) => [uniqueIndex('guard_display_sequences_pkey').on(table.organisationId, table.kind)],
);

export const guardThreats = pgTable(
  'guard_threats',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    displayNumber: integer('display_number').notNull(),
    type: text('type').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull(),
    title: text('title').notNull(),
    primaryEventId: uuid('primary_event_id')
      .notNull()
      .references(() => guardEvents.id),
    decisionId: text('decision_id'),
    aiSystemId: uuid('ai_system_id').references(() => aiSystems.id),
    systemName: text('system_name'),
    environmentId: uuid('environment_id').references(() => environments.id),
    environmentLabel: text('environment_label'),
    provider: text('provider'),
    model: text('model'),
    policyId: uuid('policy_id'),
    policyName: text('policy_name'),
    policyVersion: integer('policy_version'),
    requestId: uuid('request_id').references(() => requests.id, { onDelete: 'set null' }),
    traceId: text('trace_id'),
    classification: text('classification').notNull().default(''),
    outcome: text('outcome').notNull().default(''),
    redactionSummary: text('redaction_summary').notNull().default(''),
    fingerprint: text('fingerprint').notNull(),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    failClosedCount: integer('fail_closed_count').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    assignedTo: uuid('assigned_to').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('guard_threats_org_number_uidx').on(table.organisationId, table.displayNumber),
    index('guard_threats_org_status_seen_idx').on(table.organisationId, table.status, table.lastSeenAt),
    index('guard_threats_org_fingerprint_idx').on(table.organisationId, table.fingerprint, table.lastSeenAt),
    index('guard_threats_org_system_idx').on(table.organisationId, table.aiSystemId),
  ],
);

export const guardThreatEvents = pgTable(
  'guard_threat_events',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    threatId: uuid('threat_id')
      .notNull()
      .references(() => guardThreats.id),
    eventId: uuid('event_id')
      .notNull()
      .references(() => guardEvents.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('guard_threat_events_org_event_uidx').on(table.organisationId, table.eventId),
    index('guard_threat_events_threat_idx').on(table.organisationId, table.threatId, table.occurredAt),
  ],
);

export const guardThreatActivity = pgTable(
  'guard_threat_activity',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    threatId: uuid('threat_id')
      .notNull()
      .references(() => guardThreats.id),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [index('guard_threat_activity_threat_idx').on(table.organisationId, table.threatId, table.createdAt)],
);

export const guardIncidentThreats = pgTable(
  'guard_incident_threats',
  {
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => guardIncidents.id),
    threatId: uuid('threat_id')
      .notNull()
      .references(() => guardThreats.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('guard_incident_threats_pkey').on(table.incidentId, table.threatId),
    index('guard_incident_threats_org_idx').on(table.organisationId, table.incidentId),
  ],
);

export const guardIncidentEvents = pgTable(
  'guard_incident_events',
  {
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => guardIncidents.id),
    eventId: uuid('event_id')
      .notNull()
      .references(() => guardEvents.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('guard_incident_events_pkey').on(table.incidentId, table.eventId),
    index('guard_incident_events_org_idx').on(table.organisationId, table.incidentId),
  ],
);

export const guardIncidentNotes = pgTable(
  'guard_incident_notes',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => guardIncidents.id),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('guard_incident_notes_incident_idx').on(table.organisationId, table.incidentId, table.createdAt)],
);

export const guardIncidentTimeline = pgTable(
  'guard_incident_timeline',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => guardIncidents.id),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [index('guard_incident_timeline_incident_idx').on(table.organisationId, table.incidentId, table.createdAt)],
);

export const guardPolicies = pgTable(
  'guard_policies',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull(),
    status: text('status').notNull(),
    mode: text('mode').notNull(),
    priority: integer('priority').notNull(),
    currentVersion: integer('current_version').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('guard_policies_org_name_uidx').on(table.organisationId, table.name),
    index('guard_policies_org_status_priority_idx').on(table.organisationId, table.status, table.priority),
  ],
);

export const guardPolicyVersions = pgTable(
  'guard_policy_versions',
  {
    id: uuid('id').primaryKey(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => guardPolicies.id, { onDelete: 'cascade' }),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    version: integer('version').notNull(),
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull(),
    conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull(),
    actions: jsonb('actions').$type<unknown[]>().notNull(),
    summary: text('summary').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('guard_policy_versions_policy_version_uidx').on(table.policyId, table.version),
    index('guard_policy_versions_org_policy_idx').on(table.organisationId, table.policyId, table.version),
  ],
);

export const guardDecisions = pgTable(
  'guard_decisions',
  {
    id: uuid('id').primaryKey(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    requestId: uuid('request_id').references(() => requests.id, { onDelete: 'set null' }),
    traceId: text('trace_id'),
    systemId: uuid('system_id').references(() => aiSystems.id),
    decision: text('decision').notNull(),
    effectiveMode: text('effective_mode').notNull(),
    wouldEnforceAction: text('would_enforce_action'),
    wouldEnforcePolicyId: uuid('would_enforce_policy_id'),
    matchedPolicies: jsonb('matched_policies').$type<unknown[]>().notNull().default([]),
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    contextSummary: jsonb('context_summary').$type<Record<string, unknown>>().notNull().default({}),
    source: text('source').notNull(),
    evaluationMs: integer('evaluation_ms').notNull(),
    policiesConsidered: integer('policies_considered').notNull(),
    policiesMatched: integer('policies_matched').notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('guard_decisions_org_time_idx').on(table.organisationId, table.evaluatedAt),
    index('guard_decisions_org_source_idx').on(table.organisationId, table.source),
  ],
);
