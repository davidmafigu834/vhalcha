export interface Metrics {
  increment(name: 'request_count' | 'errors' | 'provider_errors' | 'budget_blocks' | 'rate_limit_blocks' | 'routing_decisions' | 'routing_fallbacks' | 'routing_rejections'): void;
  observeLatency(latencyMs: number): void;
  snapshot(): { counters: Record<string, number>; latencyMs: number[] };
}

export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  const latencyMs: number[] = [];
  return {
    increment(name) {
      counters.set(name, (counters.get(name) ?? 0) + 1);
    },
    observeLatency(value) {
      latencyMs.push(value);
      if (latencyMs.length > 200) {
        latencyMs.shift();
      }
    },
    snapshot() {
      return { counters: Object.fromEntries(counters), latencyMs: [...latencyMs] };
    },
  };
}
