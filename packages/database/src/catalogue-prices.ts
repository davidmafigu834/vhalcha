import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from './client';
import { modelCatalogue } from './schema';

/**
 * Authoritative price update payload. Runtime routing, reservations, and usage
 * read model_catalogue, not this file.
 *
 * To change a price: edit this list, then run `pnpm db:sync-prices`
 * with DATABASE_ADMIN_URL or DATABASE_URL. The command updates matching rows
 * and can insert missing Anthropic/Google catalogue IDs via migration 0007.
 * It does not use ON CONFLICT DO NOTHING as the only update path.
 *
 * Prices in this file must be reviewed against official provider pricing pages
 * before verifying. priceVerifiedAt is the moment Vhalcha last confirmed the rate.
 */
export interface CataloguePriceUpdate {
  provider: 'openai' | 'anthropic' | 'google' | 'mock';
  modelName: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number | null;
  effectiveAt: string;
  source: string;
}

export const cataloguePriceUpdates: CataloguePriceUpdate[] = [
  {
    provider: 'mock',
    modelName: 'economy-model',
    inputUsdPerMillion: 0.05,
    outputUsdPerMillion: 0.2,
    effectiveAt: '2026-01-01',
    source: 'Vhalcha mock catalogue fixture. Not a provider invoice.',
  },
  {
    provider: 'mock',
    modelName: 'standard-model',
    inputUsdPerMillion: 0.4,
    outputUsdPerMillion: 1.6,
    effectiveAt: '2026-01-01',
    source: 'Vhalcha mock catalogue fixture. Not a provider invoice.',
  },
  {
    provider: 'mock',
    modelName: 'premium-model',
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 8,
    effectiveAt: '2026-01-01',
    source: 'Vhalcha mock catalogue fixture. Not a provider invoice.',
  },
  {
    provider: 'openai',
    modelName: 'gpt-4.1',
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 8,
    effectiveAt: '2025-04-14',
    source: 'OpenAI published gpt-4.1 standard rates, re-verified for Vhalcha on 2026-09-29 against OpenAI pricing docs. Cached input is not applied by the Vhalcha adapter.',
  },
  {
    provider: 'openai',
    modelName: 'gpt-4.1-mini',
    inputUsdPerMillion: 0.4,
    outputUsdPerMillion: 1.6,
    effectiveAt: '2025-04-14',
    source: 'OpenAI published gpt-4.1-mini standard rates, re-verified for Vhalcha on 2026-09-29 against OpenAI pricing docs. Cached input is not applied by the Vhalcha adapter.',
  },
  {
    provider: 'openai',
    modelName: 'gpt-4o',
    inputUsdPerMillion: 2.5,
    outputUsdPerMillion: 10,
    effectiveAt: '2024-08-06',
    source: 'OpenAI published gpt-4o standard rates, re-verified for Vhalcha on 2026-09-29 against OpenAI pricing docs. Cached input is not applied by the Vhalcha adapter.',
  },
  {
    provider: 'openai',
    modelName: 'gpt-4o-mini',
    inputUsdPerMillion: 0.15,
    outputUsdPerMillion: 0.6,
    effectiveAt: '2024-07-18',
    source: 'OpenAI published gpt-4o-mini standard rates, re-verified for Vhalcha on 2026-09-29 against OpenAI pricing docs. Cached input is not applied by the Vhalcha adapter.',
  },
  {
    provider: 'anthropic',
    modelName: 'claude-haiku-4-5-20251001',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.1,
    effectiveAt: '2025-10-01',
    source: 'Anthropic published Claude Haiku 4.5 rates (platform.claude.com/docs/en/about-claude/pricing), verified for Vhalcha on 2026-09-29. Cache read $0.10/MTok.',
  },
  {
    provider: 'anthropic',
    modelName: 'claude-sonnet-5',
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 0.2,
    effectiveAt: '2026-08-10',
    source: 'Anthropic published Claude Sonnet 5 rates (platform.claude.com/docs/en/about-claude/pricing), verified for Vhalcha on 2026-09-29. Cache read $0.20/MTok.',
  },
  {
    provider: 'google',
    modelName: 'gemini-2.5-flash',
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.03,
    effectiveAt: '2025-05-01',
    source: 'Google Gemini Developer API paid-tier text rates for gemini-2.5-flash (ai.google.dev/gemini-api/docs/pricing), verified for Vhalcha on 2026-09-29. Cached input $0.03/MTok when reported.',
  },
  {
    provider: 'google',
    modelName: 'gemini-2.5-pro',
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 0.125,
    effectiveAt: '2025-05-01',
    source: 'Google Gemini Developer API paid-tier text rates for gemini-2.5-pro prompts <=200k (ai.google.dev/gemini-api/docs/pricing), verified for Vhalcha on 2026-09-29.',
  },
];

export async function syncCataloguePrices(db: AppDatabase, verifiedAt = new Date()): Promise<number> {
  let updated = 0;
  for (const price of cataloguePriceUpdates) {
    const rows = await db
      .update(modelCatalogue)
      .set({
        inputUsdPerMillion: price.inputUsdPerMillion.toFixed(6),
        outputUsdPerMillion: price.outputUsdPerMillion.toFixed(6),
        cachedInputUsdPerMillion:
          price.cachedInputUsdPerMillion === null || price.cachedInputUsdPerMillion === undefined
            ? null
            : price.cachedInputUsdPerMillion.toFixed(6),
        currency: 'USD',
        priceEffectiveAt: new Date(`${price.effectiveAt}T00:00:00.000Z`),
        priceVerifiedAt: verifiedAt,
        priceSource: price.source,
      })
      .where(and(eq(modelCatalogue.provider, price.provider), eq(modelCatalogue.modelName, price.modelName)))
      .returning({ id: modelCatalogue.id });
    updated += rows.length;
  }
  return updated;
}
