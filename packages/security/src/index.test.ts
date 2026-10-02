import { describe, expect, it } from 'vitest';
import {
  generateVirtualApiKey,
  hashPassword,
  isVirtualApiKeyShape,
  verifyPassword,
  verifyVirtualApiKeyHash,
} from './index';

describe('virtual API keys', () => {
  it('creates a high-entropy key and stores only prefix and hash', () => {
    const development = generateVirtualApiKey('development');
    const production = generateVirtualApiKey('production');

    expect(development.rawKey.startsWith('vh_test_')).toBe(true);
    expect(production.rawKey.startsWith('vh_live_')).toBe(true);
    expect(isVirtualApiKeyShape(development.rawKey)).toBe(true);
    expect(development.keyPrefix).toHaveLength(16);
    expect(development.keyHash).toHaveLength(64);
    expect(development.keyHash).not.toContain(development.rawKey);
    expect(verifyVirtualApiKeyHash(development.rawKey, development.keyHash)).toBe(true);
    expect(verifyVirtualApiKeyHash(production.rawKey, development.keyHash)).toBe(false);
    expect(development.rawKey).not.toBe(generateVirtualApiKey('development').rawKey);
  });
});

describe('passwords', () => {
  it('verifies a matching password and rejects a different one', async () => {
    const stored = await hashPassword('ChangeMe-Dev-Only-1');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('ChangeMe-Dev-Only-1', stored)).toBe(true);
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
  });
});
