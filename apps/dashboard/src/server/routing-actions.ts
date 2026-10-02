'use server';

import { redirect } from 'next/navigation';
import { createRepositories, createRoutingRepository } from '@vhalcha/database';
import { auditActions } from '@vhalcha/audit';
import { byokStorageAvailable } from '@vhalcha/config';
import { verifyProviderCredential, type ProviderId } from '@vhalcha/providers';
import { encryptSecret } from '@vhalcha/security';
import { getServices, requirePermission } from './services';

const connectableProviders = new Set(['openai', 'anthropic', 'google']);

function providerLabel(provider: string) {
  if (provider === 'anthropic') return 'Organisation Anthropic';
  if (provider === 'google') return 'Organisation Google';
  return 'Organisation OpenAI';
}

export async function updateRoutingPolicy(formData: FormData) {
  const session = await requirePermission('routing:write');
  const aiSystemId = String(formData.get('ai_system_id') ?? '');
  const routingMode = String(formData.get('routing_mode') ?? 'fixed');
  const routingStrategy = String(formData.get('routing_strategy') ?? 'balanced');
  const baselineModelId = String(formData.get('baseline_model_id') ?? '').trim();
  const maxCost = String(formData.get('max_request_cost_usd') ?? '').trim();
  if (!aiSystemId || (routingMode !== 'fixed' && routingMode !== 'optimised')) {
    throw new Error('A valid AI system and routing mode are required.');
  }
  const routing = createRoutingRepository(getServices().db);
  if (baselineModelId) {
    const catalogue = await routing.listCatalogue();
    const model = catalogue.find((row) => row.id === baselineModelId);
    const grants = await routing.listAccess(session.claims.oid);
    const approved = grants.some((row) => row.modelCatalogueId === baselineModelId && row.status === 'allowed');
    const priced =
      model !== undefined &&
      Number.isFinite(Number(model.inputUsdPerMillion)) &&
      Number.isFinite(Number(model.outputUsdPerMillion));
    if (!model || !priced || !approved) {
      throw new Error('The baseline model must exist, have a price, and be organisation-approved.');
    }
  }
  const preferred = String(formData.get('preferred_providers') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = String(formData.get('allowed_providers') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const prohibited = String(formData.get('prohibited_providers') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  await routing.updateSystem(session.claims.oid, aiSystemId, {
    routingMode,
    routingStrategy,
    baselineModelId: baselineModelId || null,
    maxRequestCostUsd: maxCost || null,
    premiumEscalation: formData.get('premium_escalation') === 'on',
    fallbackEnabled: formData.get('fallback_enabled') === 'on',
    routingConstraints: {
      preferred_providers: preferred,
      allowed_providers: allowed,
      prohibited_providers: prohibited,
    },
  });
  await createRepositories(getServices().db).audit.create(session.claims.oid, {
    organisationId: session.claims.oid,
    actorType: 'user',
    actorId: session.claims.uid,
    action: auditActions.routingPolicyUpdated,
    resourceType: 'ai_system',
    resourceId: aiSystemId,
    result: 'success',
    severity: 'info',
    metadata: { ai_system_id: aiSystemId, routing_mode: routingMode, routing_strategy: routingStrategy },
  });
  redirect('/gateway/routing');
}

export async function setOrganisationModel(formData: FormData) {
  const session = await requirePermission('routing:manage');
  const modelCatalogueId = String(formData.get('model_catalogue_id') ?? '');
  const status = String(formData.get('status') ?? '');
  if (!modelCatalogueId || (status !== 'allowed' && status !== 'blocked')) {
    throw new Error('A model and an allow or block status are required.');
  }
  const routing = createRoutingRepository(getServices().db);
  await routing.setAccess({
    organisationId: session.claims.oid,
    modelCatalogueId,
    status,
  });
  await createRepositories(getServices().db).audit.create(session.claims.oid, {
    organisationId: session.claims.oid,
    actorType: 'user',
    actorId: session.claims.uid,
    action: status === 'allowed' ? auditActions.routingModelAllowed : auditActions.routingModelBlocked,
    resourceType: 'model_catalogue',
    resourceId: modelCatalogueId,
    result: 'success',
    severity: 'info',
    metadata: { model_catalogue_id: modelCatalogueId, status },
  });
  redirect('/gateway/models');
}

export async function enablePlatformProvider(formData: FormData) {
  const session = await requirePermission('providers:write');
  const environmentId = String(formData.get('environment_id') ?? '');
  const provider = String(formData.get('provider') ?? 'openai');
  if (!environmentId || !connectableProviders.has(provider)) {
    throw new Error('A provider and environment are required.');
  }
  const repos = createRepositories(getServices().db);
  const created = await repos.providerConnections.create({
    organisationId: session.claims.oid,
    environmentId,
    provider,
    name:
      provider === 'anthropic'
        ? 'Vhalcha platform Anthropic'
        : provider === 'google'
          ? 'Vhalcha platform Google'
          : 'Vhalcha platform OpenAI',
    credentialSource: 'platform_env',
  });
  await repos.audit.create(session.claims.oid, {
    organisationId: session.claims.oid,
    environmentId,
    actorType: 'user',
    actorId: session.claims.uid,
    action: auditActions.providerConnectionCreated,
    resourceType: 'provider_connection',
    resourceId: created.id,
    result: 'success',
    severity: 'info',
    metadata: { provider, credential_source: 'platform_env' },
  });
  redirect('/gateway/providers');
}

export async function connectOrganisationProvider(formData: FormData) {
  const session = await requirePermission('providers:write');
  const secret = String(formData.get('api_key') ?? '');
  const environmentId = String(formData.get('environment_id') ?? '');
  const provider = String(formData.get('provider') ?? 'openai');
  const keyMaterial = process.env.VHALCHA_SECRETS_KEY ?? '';
  if (!byokStorageAvailable(keyMaterial)) {
    throw new Error('Organisation provider credentials are disabled until VHALCHA_SECRETS_KEY is configured.');
  }
  if (!secret || !environmentId || !connectableProviders.has(provider)) {
    throw new Error('A provider credential is required.');
  }
  const encryptedCredentials = encryptSecret(secret, keyMaterial);
  const repos = createRepositories(getServices().db);
  const created = await repos.providerConnections.connectOrganisation({
    organisationId: session.claims.oid,
    environmentId,
    provider,
    name: providerLabel(provider),
    encryptedCredentials,
  });
  await repos.audit.create(session.claims.oid, {
    organisationId: session.claims.oid,
    environmentId,
    actorType: 'user',
    actorId: session.claims.uid,
    action: auditActions.providerConnectionCreated,
    resourceType: 'provider_connection',
    resourceId: created.id,
    result: 'success',
    severity: 'info',
    metadata: { provider, credential_source: 'organisation' },
  });
  await verifyAndStoreConnection(session.claims.oid, session.claims.uid, created.id, provider as ProviderId, secret);
  redirect('/gateway/providers');
}

export async function testProviderConnection(formData: FormData) {
  const session = await requirePermission('providers:write');
  const connectionId = String(formData.get('connection_id') ?? '');
  const keyMaterial = process.env.VHALCHA_SECRETS_KEY ?? '';
  if (!connectionId) {
    throw new Error('A provider connection is required.');
  }
  if (!byokStorageAvailable(keyMaterial)) {
    throw new Error('Organisation provider credentials are disabled until VHALCHA_SECRETS_KEY is configured.');
  }
  const repos = createRepositories(getServices().db);
  const connections = await repos.providerConnections.list(session.claims.oid);
  const connection = connections.find((row) => row.id === connectionId);
  if (!connection || !connectableProviders.has(connection.provider)) {
    throw new Error('A provider connection is required.');
  }
  const full = await repos.providerConnections.findActive(session.claims.oid, connection.environmentId, connection.provider);
  if (!full?.encryptedCredentials || full.id !== connectionId) {
    throw new Error('The organisation provider credential could not be read.');
  }
  const { decryptSecret } = await import('@vhalcha/security');
  let secret: string;
  try {
    secret = decryptSecret(full.encryptedCredentials, keyMaterial);
  } catch {
    throw new Error('The organisation provider credential could not be read.');
  }
  await verifyAndStoreConnection(session.claims.oid, session.claims.uid, connectionId, connection.provider as ProviderId, secret);
  redirect('/gateway/providers');
}

async function verifyAndStoreConnection(
  organisationId: string,
  actorId: string,
  connectionId: string,
  provider: ProviderId,
  secret: string,
) {
  const repos = createRepositories(getServices().db);
  const now = new Date();
  await repos.audit.create(organisationId, {
    organisationId,
    actorType: 'user',
    actorId,
    action: auditActions.providerVerificationStarted,
    resourceType: 'provider_connection',
    resourceId: connectionId,
    result: 'success',
    severity: 'info',
    metadata: { provider },
  });
  const result = await verifyProviderCredential({ provider, apiKey: secret });
  await repos.providerConnections.setVerification(organisationId, connectionId, {
    verificationStatus: result.ok ? 'verified' : 'failed',
    verificationErrorCode: result.ok ? null : result.code,
    verifiedAt: result.ok ? now : null,
    lastCheckedAt: now,
  });
  await repos.audit.create(organisationId, {
    organisationId,
    actorType: 'user',
    actorId,
    action: result.ok ? auditActions.providerVerificationSucceeded : auditActions.providerVerificationFailed,
    resourceType: 'provider_connection',
    resourceId: connectionId,
    result: result.ok ? 'success' : 'failure',
    severity: result.ok ? 'info' : 'warning',
    metadata: { provider, verification_code: result.code },
  });
}

export async function disableProviderConnection(formData: FormData) {
  const session = await requirePermission('providers:write');
  const connectionId = String(formData.get('connection_id') ?? '');
  if (!connectionId) {
    throw new Error('A provider connection is required.');
  }
  await createRepositories(getServices().db).providerConnections.setStatus(session.claims.oid, connectionId, 'disabled');
  await createRepositories(getServices().db).audit.create(session.claims.oid, {
    organisationId: session.claims.oid,
    actorType: 'user',
    actorId: session.claims.uid,
    action: auditActions.providerConnectionDisabled,
    resourceType: 'provider_connection',
    resourceId: connectionId,
    result: 'success',
    severity: 'warning',
    metadata: { connection_id: connectionId },
  });
  redirect('/gateway/providers');
}
