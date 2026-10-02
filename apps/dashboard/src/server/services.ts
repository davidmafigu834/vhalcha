import { cookies } from 'next/headers';
import { createLocalAuthProvider } from '@vhalcha/auth/local';
import { assertPermission, AuthorizationError, hasPermission, type Permission } from '@vhalcha/auth';
import { loadDashboardConfig, loadEnvFile } from '@vhalcha/config';
import { createDatabase, createRepositories, type AppDatabase } from '@vhalcha/database';
import { createLogger } from '@vhalcha/logger';
import { createRedisClient, redisKeys, type KeyValueStore } from '@vhalcha/redis';

interface Services {
  db: AppDatabase;
  config: ReturnType<typeof loadDashboardConfig>;
  auth: ReturnType<typeof createLocalAuthProvider>;
  redis: KeyValueStore | null;
  logger: ReturnType<typeof createLogger>;
}

let services: Services | null = null;

export function getServices(): Services {
  if (!services) {
    loadEnvFile();
    const config = loadDashboardConfig();
    const logger = createLogger('dashboard', config.LOG_LEVEL);
    const { db } = createDatabase(config.DATABASE_URL);
    const redisUrl = process.env.REDIS_URL;
    services = {
      db,
      config,
      logger,
      redis: redisUrl ? createRedisClient(redisUrl) : null,
      auth: createLocalAuthProvider({
        db,
        secret: config.SESSION_SECRET,
        onResetIssued: ({ resetPath }) => {
          if (config.VHALCHA_ENV === 'development') {
            logger.info({ resetPath }, 'development password reset path');
            return;
          }
          logger.info('password reset issued');
        },
      }),
    };
  }
  return services;
}

export async function readSession() {
  const token = (await cookies()).get('vh_session')?.value;
  if (!token) {
    return null;
  }
  return getServices().auth.getSession(token);
}

export async function requirePermission(permission: Permission) {
  const session = await readSession();
  if (!session) {
    throw new AuthorizationError(permission);
  }
  try {
    assertPermission(session.role, permission);
  } catch (error) {
    getServices().logger.warn({ permission, role: session.role, event: 'permission_denied' }, 'permission denied');
    throw error;
  }
  return session;
}

export async function requirePageAccess(permission: Permission) {
  const session = await readSession();
  if (!session) {
    return null;
  }
  if (!hasPermission(session.role, permission)) {
    getServices().logger.warn({ permission, role: session.role, event: 'permission_denied' }, 'permission denied');
    return { denied: true as const };
  }
  return session;
}

export async function invalidateVirtualKey(keyHash: string) {
  const redis = getServices().redis;
  if (!redis) {
    return;
  }
  await redis.del(redisKeys.key(keyHash)).catch(() => undefined);
}

export function repositories() {
  return createRepositories(getServices().db);
}

export function permissionError(error: unknown) {
  if (error instanceof AuthorizationError) {
    return 'You do not have permission to do that.';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'The change could not be saved.';
}
