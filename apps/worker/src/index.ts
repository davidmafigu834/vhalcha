import { loadEnvFile, loadWorkerConfig } from '@vhalcha/config';
import { createDatabase } from '@vhalcha/database';
import { createLogger, initErrorTracking } from '@vhalcha/logger';
import { createRedisClient, redisKeys, type KeyValueStore } from '@vhalcha/redis';
import { runWorkerJob, type WorkerJob } from './jobs';

loadEnvFile();
const config = loadWorkerConfig();
const logger = createLogger('worker', config.LOG_LEVEL);
const tracker = await initErrorTracking(config.SENTRY_DSN || undefined);
const { db, pool } = createDatabase(config.DATABASE_URL);
const redis = createRedisClient(config.REDIS_URL);
let running = true;

async function maintenance(now = new Date()) {
  await runWorkerJob(db, { type: 'daily_spend_summary' }, now);
  await runWorkerJob(db, { type: 'monthly_spend_summary' }, now);
  await runWorkerJob(db, { type: 'cleanup' }, now);
}

async function consume(queue: KeyValueStore) {
  const raw = await queue.dequeue(redisKeys.queue());
  if (!raw) {
    return false;
  }
  const job = JSON.parse(raw) as WorkerJob;
  try {
    await runWorkerJob(db, job);
  } catch (error) {
    const canRetry = Boolean(error && typeof error === 'object' && 'retryable' in error && error.retryable);
    if (canRetry && job.type === 'knowledge.ingest') {
      await queue.enqueue(redisKeys.queue(), raw);
    }
    throw error;
  }
  logger.info({ job_type: job.type }, 'worker job completed');
  return true;
}

let primed = false;

while (running) {
  try {
    if (!primed) {
      await redis.enqueue(
        redisKeys.queue(),
        JSON.stringify({ type: 'monthly_spend_summary' } satisfies WorkerJob),
      );
      primed = true;
    }
    const worked = await consume(redis);
    if (!worked) {
      await maintenance();
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  } catch (error) {
    logger.error({ name: error instanceof Error ? error.name : 'Error' }, 'worker job failed');
    tracker.captureException(error);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

process.on('SIGINT', () => {
  running = false;
});
process.on('SIGTERM', () => {
  running = false;
});

process.on('beforeExit', () => {
  void pool.end();
});
