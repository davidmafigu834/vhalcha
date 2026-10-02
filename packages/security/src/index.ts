import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { EnvironmentType } from '@vhalcha/types';

const scryptAsync = promisify(scrypt);

export function generateVirtualApiKey(environmentType: EnvironmentType): {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
} {
  const prefix = environmentType === 'production' ? 'vh_live_' : 'vh_test_';
  const entropy = randomBytes(32).toString('base64url');
  const rawKey = `${prefix}${entropy}`;
  return {
    rawKey,
    keyPrefix: rawKey.slice(0, 16),
    keyHash: hashVirtualApiKey(rawKey),
  };
}

export function hashVirtualApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function verifyVirtualApiKeyHash(rawKey: string, expectedHash: string): boolean {
  const actual = hashVirtualApiKey(rawKey);
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  if (actualBuffer.length === 0 || actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isVirtualApiKeyShape(value: string): boolean {
  return /^vh_(test|live)_[A-Za-z0-9_-]{43}$/.test(value);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, hash] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !hash) {
    return false;
  }
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

export const securityHeaders: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-dns-prefetch-control': 'off',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export const IMPLEMENTED_CONTENT_LOGGING_MODE = 'metadata_only' as const;

function secretsKey(keyMaterial: string): Buffer {
  const trimmed = keyMaterial.trim();
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 32) {
    return decoded;
  }
  if (Buffer.byteLength(trimmed) === 32) {
    return Buffer.from(trimmed);
  }
  throw new Error('Invalid environment configuration: VHALCHA_SECRETS_KEY');
}

export function encryptSecret(plaintext: string, keyMaterial: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretsKey(keyMaterial), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(payload: string, keyMaterial: string): string {
  const [version, ivText, tagText, body] = payload.split('.');
  if (version !== 'v1' || !ivText || !tagText || !body) {
    throw new Error('provider_credentials_unreadable');
  }
  const decipher = createDecipheriv('aes-256-gcm', secretsKey(keyMaterial), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

export function assertMetadataOnlyLogging(mode: string): void {
  if (mode !== IMPLEMENTED_CONTENT_LOGGING_MODE) {
    throw new Error('V1 stores request metadata only. Prompt and response logging is not enabled.');
  }
}
