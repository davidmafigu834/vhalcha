import type { ProviderHealthState } from './types';

export const HEALTH_FAILURES_TO_OPEN = 3;
export const HEALTH_COOLDOWN_MS = 60_000;

export interface HealthSnapshot {
  status: ProviderHealthState;
  consecutiveFailures: number;
  cooldownUntil: Date | null;
}

export function effectiveHealth(snapshot: HealthSnapshot | null, now: Date): ProviderHealthState {
  if (!snapshot) {
    return 'healthy';
  }
  if (snapshot.status === 'unavailable' && snapshot.cooldownUntil && snapshot.cooldownUntil <= now) {
    return 'degraded';
  }
  return snapshot.status;
}

export function healthAfterSuccess(): HealthSnapshot {
  return { status: 'healthy', consecutiveFailures: 0, cooldownUntil: null };
}

export function healthAfterFailure(snapshot: HealthSnapshot | null, now: Date): HealthSnapshot {
  const current = snapshot ?? { status: 'healthy' as const, consecutiveFailures: 0, cooldownUntil: null };
  const failures = current.consecutiveFailures + 1;
  if (failures >= HEALTH_FAILURES_TO_OPEN) {
    return {
      status: 'unavailable',
      consecutiveFailures: failures,
      cooldownUntil: new Date(now.getTime() + HEALTH_COOLDOWN_MS),
    };
  }
  return {
    status: failures >= 2 ? 'degraded' : 'healthy',
    consecutiveFailures: failures,
    cooldownUntil: null,
  };
}
