import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { effectiveHealth, healthAfterFailure, healthAfterSuccess, type HealthSnapshot } from '@vhalcha/routing';
import type { AppDatabase } from './client';
import {
  aiSystems,
  modelCatalogue,
  organisationModelAccess,
  providerHealth,
  requestProviderAttempts,
  routingDecisions,
} from './schema';
import { usingTenant } from './tenant';

function numberFrom(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return Number(value);
}

export function createRoutingRepository(db: AppDatabase) {
  return {
    async updateSystem(organisationId: string, aiSystemId: string, patch: {
      routingMode?: string;
      routingStrategy?: string;
      baselineModelId?: string | null;
      maxRequestCostUsd?: string | null;
      premiumEscalation?: boolean;
      fallbackEnabled?: boolean;
      maxProviderAttempts?: number;
      routingConstraints?: Record<string, unknown>;
    }) {
      await usingTenant(db, organisationId, async (tx) => {
        await tx
          .update(aiSystems)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(aiSystems.organisationId, organisationId), eq(aiSystems.id, aiSystemId)));
      });
    },
    async listCatalogue() {
      return db.select().from(modelCatalogue).where(eq(modelCatalogue.status, 'active'));
    },
    async findCatalogueModel(provider: string, modelName: string) {
      const rows = await db
        .select()
        .from(modelCatalogue)
        .where(and(eq(modelCatalogue.provider, provider), eq(modelCatalogue.modelName, modelName), eq(modelCatalogue.status, 'active')))
        .limit(1);
      return rows[0] ?? null;
    },
    async recordAttempt(input: {
      organisationId: string;
      requestId: string;
      routingDecisionId?: string | null;
      attemptNumber: number;
      provider: string;
      model: string;
      reason: string;
      status: 'succeeded' | 'failed' | 'escalated';
      inputTokens?: number | null;
      outputTokens?: number | null;
      estimatedCostUsd?: number | null;
      actualCostUsd?: number | null;
      errorCode?: string | null;
      billable: boolean;
      startedAt: Date;
      completedAt: Date;
    }) {
      const id = randomUUID();
      await usingTenant(db, input.organisationId, async (tx) => {
        await tx.insert(requestProviderAttempts).values({
          id,
          organisationId: input.organisationId,
          requestId: input.requestId,
          routingDecisionId: input.routingDecisionId ?? null,
          attemptNumber: input.attemptNumber,
          provider: input.provider,
          model: input.model,
          reason: input.reason,
          status: input.status,
          inputTokens: input.inputTokens ?? null,
          outputTokens: input.outputTokens ?? null,
          estimatedCostUsd: input.estimatedCostUsd === null || input.estimatedCostUsd === undefined ? null : input.estimatedCostUsd.toFixed(8),
          actualCostUsd: input.actualCostUsd === null || input.actualCostUsd === undefined ? null : input.actualCostUsd.toFixed(8),
          errorCode: input.errorCode ?? null,
          billable: input.billable,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
        });
      });
      return id;
    },
    async listAttempts(organisationId: string, requestId: string) {
      return usingTenant(db, organisationId, async (tx) =>
        tx
          .select()
          .from(requestProviderAttempts)
          .where(and(eq(requestProviderAttempts.organisationId, organisationId), eq(requestProviderAttempts.requestId, requestId)))
          .orderBy(asc(requestProviderAttempts.attemptNumber)),
      );
    },
    async listAccess(organisationId: string) {
      return usingTenant(db, organisationId, async (tx) =>
        tx.select().from(organisationModelAccess).where(eq(organisationModelAccess.organisationId, organisationId)),
      );
    },
    async setAccess(input: {
      organisationId: string;
      modelCatalogueId: string;
      status: 'allowed' | 'blocked';
      tierOverride?: string | null;
    }) {
      return usingTenant(db, input.organisationId, async (tx) => {
        const existing = await tx
          .select()
          .from(organisationModelAccess)
          .where(
            and(
              eq(organisationModelAccess.organisationId, input.organisationId),
              eq(organisationModelAccess.modelCatalogueId, input.modelCatalogueId),
            ),
          )
          .limit(1);
        if (existing[0]) {
          await tx
            .update(organisationModelAccess)
            .set({
              status: input.status,
              tierOverride: input.tierOverride ?? existing[0].tierOverride,
              updatedAt: new Date(),
            })
            .where(eq(organisationModelAccess.id, existing[0].id));
          return existing[0].id;
        }
        const id = randomUUID();
        await tx.insert(organisationModelAccess).values({
          id,
          organisationId: input.organisationId,
          modelCatalogueId: input.modelCatalogueId,
          status: input.status,
          tierOverride: input.tierOverride ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        return id;
      });
    },
    async listHealth(organisationId: string, environmentId: string) {
      return usingTenant(db, organisationId, async (tx) =>
        tx
          .select()
          .from(providerHealth)
          .where(
            and(eq(providerHealth.organisationId, organisationId), eq(providerHealth.environmentId, environmentId)),
          ),
      );
    },
    async applyHealth(input: {
      organisationId: string;
      environmentId: string;
      provider: string;
      modelName: string;
      outcome: 'success' | 'failure';
      now: Date;
    }) {
      return usingTenant(db, input.organisationId, async (tx) => {
        const rows = await tx
          .select()
          .from(providerHealth)
          .where(
            and(
              eq(providerHealth.organisationId, input.organisationId),
              eq(providerHealth.environmentId, input.environmentId),
              eq(providerHealth.provider, input.provider),
              eq(providerHealth.modelName, input.modelName),
            ),
          )
          .limit(1)
          .for('update');
        const current: HealthSnapshot | null = rows[0]
          ? {
              status: rows[0].status as HealthSnapshot['status'],
              consecutiveFailures: rows[0].consecutiveFailures,
              cooldownUntil: rows[0].cooldownUntil,
            }
          : null;
        const next = input.outcome === 'success' ? healthAfterSuccess() : healthAfterFailure(current, input.now);
        if (rows[0]) {
          await tx
            .update(providerHealth)
            .set({
              status: next.status,
              consecutiveFailures: next.consecutiveFailures,
              cooldownUntil: next.cooldownUntil,
              updatedAt: input.now,
            })
            .where(eq(providerHealth.id, rows[0].id));
          return next;
        }
        await tx.insert(providerHealth).values({
          id: randomUUID(),
          organisationId: input.organisationId,
          environmentId: input.environmentId,
          provider: input.provider,
          modelName: input.modelName,
          status: next.status,
          consecutiveFailures: next.consecutiveFailures,
          cooldownUntil: next.cooldownUntil,
          updatedAt: input.now,
        });
        return next;
      });
    },
    async recordDecision(input: {
      organisationId: string;
      requestId: string;
      aiSystemId: string;
      routingMode: string;
      routingStrategy: string;
      selectedProvider: string;
      selectedModel: string;
      selectedModelId: string | null;
      candidateCount: number;
      complexity: string;
      risk: string;
      estimatedInputTokens: number;
      estimatedOutputTokens: number;
      estimatedSelectedCost: number | null;
      estimatedBaselineCost: number | null;
      estimatedSavings: number | null;
      decisionReason: Record<string, unknown>;
      fallbackFrom?: string | null;
      fallbackReason?: string | null;
    }) {
      const id = randomUUID();
      await usingTenant(db, input.organisationId, async (tx) => {
        await tx.insert(routingDecisions).values({
          id,
          organisationId: input.organisationId,
          requestId: input.requestId,
          aiSystemId: input.aiSystemId,
          routingMode: input.routingMode,
          routingStrategy: input.routingStrategy,
          selectedProvider: input.selectedProvider,
          selectedModel: input.selectedModel,
          selectedModelId: input.selectedModelId,
          candidateCount: input.candidateCount,
          complexity: input.complexity,
          risk: input.risk,
          estimatedInputTokens: input.estimatedInputTokens,
          estimatedOutputTokens: input.estimatedOutputTokens,
          estimatedSelectedCost: input.estimatedSelectedCost === null ? null : input.estimatedSelectedCost.toFixed(8),
          estimatedBaselineCost: input.estimatedBaselineCost === null ? null : input.estimatedBaselineCost.toFixed(8),
          estimatedSavings: input.estimatedSavings === null ? null : input.estimatedSavings.toFixed(8),
          decisionReason: input.decisionReason,
          fallbackFrom: input.fallbackFrom ?? null,
          fallbackReason: input.fallbackReason ?? null,
          createdAt: new Date(),
        });
      });
      return id;
    },
    async markFallback(organisationId: string, requestId: string, fallbackFrom: string, fallbackReason: string, selected: {
      provider: string;
      model: string;
      modelId: string | null;
      estimatedSelectedCost: number | null;
    }) {
      await usingTenant(db, organisationId, async (tx) => {
        await tx
          .update(routingDecisions)
          .set({
            fallbackFrom,
            fallbackReason,
            selectedProvider: selected.provider,
            selectedModel: selected.model,
            selectedModelId: selected.modelId,
            estimatedSelectedCost: selected.estimatedSelectedCost === null ? null : selected.estimatedSelectedCost.toFixed(8),
          })
          .where(and(eq(routingDecisions.organisationId, organisationId), eq(routingDecisions.requestId, requestId)));
      });
    },
    async findByRequest(organisationId: string, requestId: string) {
      return usingTenant(db, organisationId, async (tx) => {
        const rows = await tx
          .select()
          .from(routingDecisions)
          .where(and(eq(routingDecisions.organisationId, organisationId), eq(routingDecisions.requestId, requestId)))
          .limit(1);
        return rows[0] ?? null;
      });
    },
    async savingsSummary(organisationId: string, start: Date, end: Date) {
      return usingTenant(db, organisationId, async (tx) => {
        const rows = await tx
          .select({
            routingMode: routingDecisions.routingMode,
            selectedModel: routingDecisions.selectedModel,
            selectedProvider: routingDecisions.selectedProvider,
            estimatedSelectedCost: routingDecisions.estimatedSelectedCost,
            estimatedBaselineCost: routingDecisions.estimatedBaselineCost,
            estimatedSavings: routingDecisions.estimatedSavings,
            fallbackFrom: routingDecisions.fallbackFrom,
            complexity: routingDecisions.complexity,
          })
          .from(routingDecisions)
          .where(
            and(
              eq(routingDecisions.organisationId, organisationId),
              gte(routingDecisions.createdAt, start),
              lte(routingDecisions.createdAt, end),
            ),
          )
          .orderBy(desc(routingDecisions.createdAt));
        const optimised = rows.filter((row) => row.routingMode === 'optimised');
        const estimatedBaseline = optimised.reduce((sum, row) => sum + numberFrom(row.estimatedBaselineCost), 0);
        const estimatedSelected = optimised.reduce((sum, row) => sum + numberFrom(row.estimatedSelectedCost), 0);
        const estimatedSavings = optimised.reduce((sum, row) => sum + numberFrom(row.estimatedSavings), 0);
        return {
          decisions: rows.length,
          optimised: optimised.length,
          fixed: rows.filter((row) => row.routingMode === 'fixed').length,
          fallbacks: rows.filter((row) => row.fallbackFrom).length,
          estimatedBaseline,
          estimatedSelected,
          estimatedSavings,
          savingsPercent: estimatedBaseline > 0 ? estimatedSavings / estimatedBaseline : null,
          rows,
        };
      });
    },
    effectiveHealth,
  };
}

export type RoutingRepository = ReturnType<typeof createRoutingRepository>;
