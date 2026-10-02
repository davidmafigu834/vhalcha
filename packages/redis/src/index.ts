import Redis from 'ioredis';

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  incr(key: string, ttlSeconds?: number): Promise<number>;
  del(key: string): Promise<void>;
  ping(): Promise<boolean>;
  enqueue(key: string, value: string): Promise<void>;
  dequeue(key: string): Promise<string | null>;
}

export class RedisUnavailableError extends Error {
  constructor() {
    super('Redis is unavailable.');
    this.name = 'RedisUnavailableError';
  }
}

export class MemoryRedis implements KeyValueStore {
  private readonly values = new Map<string, { value: string; expiresAt: number | null }>();
  private readonly lists = new Map<string, string[]>();

  async get(key: string): Promise<string | null> {
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.values.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const current = await this.get(key);
    if (current !== null) {
      return false;
    }
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const current = await this.get(key);
    const next = (current ? Number(current) : 0) + 1;
    const existing = this.values.get(key);
    const expiresAt =
      existing?.expiresAt ?? (ttlSeconds ? Date.now() + ttlSeconds * 1000 : null);
    this.values.set(key, { value: String(next), expiresAt });
    return next;
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async enqueue(key: string, value: string): Promise<void> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
  }

  async dequeue(key: string): Promise<string | null> {
    const list = this.lists.get(key);
    if (!list || list.length === 0) {
      return null;
    }
    return list.shift() ?? null;
  }
}

class IoredisStore implements KeyValueStore {
  private connectOnce: Promise<void> | null = null;

  constructor(private readonly client: Redis) {}

  private ensureConnected(): Promise<void> {
    if (this.client.status === 'ready') {
      return Promise.resolve();
    }
    if (!this.connectOnce) {
      this.connectOnce = this.client
        .connect()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.connectOnce = null;
          throw error;
        });
    }
    return this.connectOnce;
  }

  async get(key: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.ensureConnected();
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
      return;
    }
    await this.client.set(key, value);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    await this.ensureConnected();
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    await this.ensureConnected();
    const count = await this.client.incr(key);
    if (count === 1 && ttlSeconds) {
      await this.client.expire(key, ttlSeconds);
    }
    return count;
  }

  async del(key: string): Promise<void> {
    await this.ensureConnected();
    await this.client.del(key);
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensureConnected();
      const response = await this.client.ping();
      return response === 'PONG';
    } catch {
      return false;
    }
  }

  async enqueue(key: string, value: string): Promise<void> {
    await this.ensureConnected();
    await this.client.lpush(key, value);
  }

  async dequeue(key: string): Promise<string | null> {
    await this.ensureConnected();
    const value = await this.client.rpop(key);
    return value ?? null;
  }
}

export function createRedisClient(url: string): KeyValueStore {
  if (url === 'memory://') {
    if (process.env.VHALCHA_ENV === 'production') {
      throw new Error('In-memory Redis is not allowed in production.');
    }
    return new MemoryRedis();
  }
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  client.on('error', () => {
    // Callers observe failure through command errors and readiness checks.
  });
  return new IoredisStore(client);
}

export const redisKeys = {
  rate(organisationId: string, aiSystemId: string, bucket: number) {
    return `vhalcha:rate:${organisationId}:${aiSystemId}:${bucket}`;
  },
  rateViolations(organisationId: string, aiSystemId: string, bucket: number) {
    return `vhalcha:rate:violations:${organisationId}:${aiSystemId}:${bucket}`;
  },
  budget(period: 'daily' | 'monthly', organisationId: string, aiSystemId: string, window: string) {
    return `vhalcha:budget:${period}:${organisationId}:${aiSystemId}:${window}`;
  },
  key(keyHash: string) {
    return `vhalcha:key:${keyHash}`;
  },
  idempotency(organisationId: string, virtualKeyId: string, idempotencyKey: string) {
    return `vhalcha:idem:${organisationId}:${virtualKeyId}:${idempotencyKey}`;
  },
  modelRules(organisationId: string, aiSystemId: string) {
    return `vhalcha:config:model-rules:${organisationId}:${aiSystemId}`;
  },
  guardPolicies(organisationId: string, policySetVersion: number) {
    return `guard:policies:${organisationId}:${policySetVersion}`;
  },
  guardPolicyVersion(organisationId: string) {
    return `guard:policy-set-version:${organisationId}`;
  },
  queue() {
    return 'vhalcha:queue:jobs';
  },
};

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtEpochSeconds: number;
}

export async function consumeRateLimit(
  store: KeyValueStore,
  input: {
    organisationId: string;
    aiSystemId: string;
    limit: number;
    windowSeconds?: number;
    now?: Date;
  },
): Promise<RateLimitDecision> {
  const windowSeconds = input.windowSeconds ?? 60;
  const nowMs = (input.now ?? new Date()).getTime();
  const bucket = Math.floor(nowMs / 1000 / windowSeconds);
  const key = redisKeys.rate(input.organisationId, input.aiSystemId, bucket);
  const count = await store.incr(key, windowSeconds * 2);
  const resetAtEpochSeconds = (bucket + 1) * windowSeconds;
  const remaining = Math.max(input.limit - count, 0);
  return {
    allowed: count <= input.limit,
    limit: input.limit,
    remaining,
    resetAtEpochSeconds,
  };
}
