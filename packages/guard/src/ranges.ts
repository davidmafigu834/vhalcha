export const guardRangeKeys = ['24h', '7d', '30d'] as const;
export type GuardRangeKey = (typeof guardRangeKeys)[number];

export interface GuardRange {
  key: GuardRangeKey;
  start: Date;
  end: Date;
  label: string;
}

const labels: Record<GuardRangeKey, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

export function resolveGuardRange(value: string | undefined, now = new Date()): GuardRange {
  const key: GuardRangeKey = value === '7d' || value === '30d' ? value : '24h';
  const hours = key === '24h' ? 24 : key === '7d' ? 24 * 7 : 24 * 30;
  return {
    key,
    start: new Date(now.getTime() - hours * 60 * 60 * 1000),
    end: now,
    label: labels[key],
  };
}
