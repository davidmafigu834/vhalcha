export interface BudgetSnapshot {
  id: string;
  name: string;
  period: 'daily' | 'monthly';
  amountUsd: number;
  warningThresholdPercent: number;
  hardLimit: boolean;
  action: 'notify' | 'block';
  spendUsd: number;
  scope: 'organisation' | 'environment' | 'ai_system';
}

export interface BudgetDecision {
  result: 'allowed' | 'warning' | 'blocked';
  blockedBy: BudgetSnapshot | null;
  warnings: BudgetSnapshot[];
  snapshots: BudgetSnapshot[];
}

export function evaluateBudgets(snapshots: BudgetSnapshot[]): BudgetDecision {
  const blockedBy =
    snapshots.find(
      (snapshot) =>
        snapshot.spendUsd >= snapshot.amountUsd && (snapshot.hardLimit || snapshot.action === 'block'),
    ) ?? null;
  if (blockedBy) {
    return { result: 'blocked', blockedBy, warnings: [], snapshots };
  }
  const warnings = snapshots.filter((snapshot) => {
    if (snapshot.amountUsd <= 0) {
      return false;
    }
    return snapshot.spendUsd >= snapshot.amountUsd * (snapshot.warningThresholdPercent / 100);
  });
  return {
    result: warnings.length > 0 ? 'warning' : 'allowed',
    blockedBy: null,
    warnings,
    snapshots,
  };
}

function zonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedStart(year: number, month: number, day: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offset = timeZoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

export function periodBounds(
  period: 'daily' | 'monthly',
  timeZone: string,
  now: Date,
): { start: Date; end: Date; label: string } {
  const parts = zonedParts(now, timeZone);
  if (period === 'daily') {
    const start = zonedStart(parts.year, parts.month, parts.day, timeZone);
    const end = zonedStart(parts.year, parts.month, parts.day + 1, timeZone);
    const label = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    return { start, end, label };
  }
  const start = zonedStart(parts.year, parts.month, 1, timeZone);
  const end = zonedStart(parts.year, parts.month + 1, 1, timeZone);
  return {
    start,
    end,
    label: `${parts.year}-${String(parts.month).padStart(2, '0')}`,
  };
}

export function usdToMicro(amount: number): number {
  return Math.round(amount * 1_000_000);
}

/** Holds expire if the gateway crashes before reconciliation. */
export const BUDGET_RESERVATION_TTL_MS = 15 * 60 * 1000;

import { estimateRequestTokens } from '@vhalcha/routing';

export { estimateRequestTokens, OUTPUT_TOKENS_BY_SIZE } from '@vhalcha/routing';

/**
 * Same estimate routing uses. Output follows request size (256 / 800 / 2000)
 * unless the client sent max_tokens. A model cap is applied by the caller
 * that knows the catalogue row.
 */
export function estimateReservationTokens(
  messages: readonly { content: string }[],
  maxTokens?: number,
): { inputTokens: number; outputTokens: number } {
  const estimate = estimateRequestTokens(messages, maxTokens);
  return {
    inputTokens: Math.max(estimate.estimatedInputTokens, messages.some((message) => message.content.trim()) ? 1 : 0),
    outputTokens: estimate.estimatedOutputTokens,
  };
}
