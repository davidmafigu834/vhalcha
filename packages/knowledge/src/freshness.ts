export type FreshnessState = 'current' | 'review_soon' | 'stale' | 'expired' | 'failed';

export function documentFreshness(input: {
  status: string;
  expiryDate: Date | null;
  indexedAt: Date | null;
  freshnessDays: number | null;
  now?: Date;
}): FreshnessState {
  const now = input.now ?? new Date();
  if (input.status === 'failed') {
    return 'failed';
  }
  if (input.expiryDate && input.expiryDate.getTime() < now.getTime()) {
    return 'expired';
  }
  if (!input.indexedAt || !input.freshnessDays || input.freshnessDays <= 0) {
    return 'current';
  }
  const ageDays = (now.getTime() - input.indexedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays > input.freshnessDays) {
    return 'stale';
  }
  if (ageDays > input.freshnessDays * 0.8) {
    return 'review_soon';
  }
  return 'current';
}

export function retrievalAllowsFreshness(
  freshness: FreshnessState,
  options: { strictGrounding: boolean; allowStale: boolean },
): boolean {
  if (freshness === 'expired' || freshness === 'failed') {
    return false;
  }
  if (freshness === 'stale') {
    return options.allowStale && !options.strictGrounding;
  }
  return freshness === 'current' || freshness === 'review_soon';
}
