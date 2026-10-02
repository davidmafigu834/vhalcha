import { describe, expect, it } from 'vitest';
import { loadDashboardConfig, loadGatewayConfig, loadWorkerConfig } from './index';

describe('loadGatewayConfig', () => {
  it('lists missing keys and does not echo secret values', () => {
    expect(() =>
      loadGatewayConfig({
        OPENAI_API_KEY: 'sk-test-secret-value',
      } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);

    try {
      loadGatewayConfig({
        OPENAI_API_KEY: 'sk-test-secret-value',
      } as NodeJS.ProcessEnv);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain('sk-test-secret-value');
    }
  });

  it('refuses mock provider mode in production', () => {
    expect(() =>
      loadGatewayConfig({
        VHALCHA_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/vhalcha',
        REDIS_URL: 'redis://localhost:6379',
        OPENAI_API_KEY: 'sk-test',
        KNOWLEDGE_STORAGE: 's3',
        KNOWLEDGE_S3_BUCKET: 'vhalcha-private',
        VHALCHA_PROVIDER_MODE: 'mock',
      } as NodeJS.ProcessEnv),
    ).toThrow(/VHALCHA_PROVIDER_MODE/);
  });

  it('refuses the in-memory redis fallback in production', () => {
    expect(() =>
      loadGatewayConfig({
        VHALCHA_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/vhalcha',
        REDIS_URL: 'memory://',
        OPENAI_API_KEY: 'sk-test',
        KNOWLEDGE_STORAGE: 's3',
        KNOWLEDGE_S3_BUCKET: 'vhalcha-private',
      } as NodeJS.ProcessEnv),
    ).toThrow(/REDIS_URL/);
  });

  it('requires the application database role in production', () => {
    expect(() =>
      loadGatewayConfig({
        VHALCHA_ENV: 'production',
        DATABASE_URL: 'postgres://vhalcha:secret@localhost:5432/vhalcha',
        REDIS_URL: 'redis://localhost:6379',
        OPENAI_API_KEY: 'sk-test',
        KNOWLEDGE_STORAGE: 's3',
        KNOWLEDGE_S3_BUCKET: 'vhalcha-private',
      } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
    const config = loadGatewayConfig({
      VHALCHA_ENV: 'production',
      DATABASE_URL: 'postgres://vhalcha_app:secret@localhost:5432/vhalcha',
      REDIS_URL: 'redis://localhost:6379',
      OPENAI_API_KEY: 'sk-test',
      KNOWLEDGE_STORAGE: 's3',
      KNOWLEDGE_S3_BUCKET: 'vhalcha-private',
    } as NodeJS.ProcessEnv);
    expect(config.DATABASE_URL).toContain('vhalcha_app');
  });
});

const productionSecret = 'k7Qm2pL9vR4xN8cW1bH6sD3fJ5aY0uT2';

describe('loadDashboardConfig', () => {
  it('rejects a placeholder session secret without echoing it', () => {
    const placeholder = 'dev-only-change-this-session-secret-32b';
    expect(() =>
      loadDashboardConfig({
        VHALCHA_ENV: 'production',
        DATABASE_URL: 'postgres://vhalcha_app:secret@localhost:5432/vhalcha',
        KNOWLEDGE_STORAGE: 's3',
        KNOWLEDGE_S3_BUCKET: 'vhalcha-private',
        SESSION_SECRET: placeholder,
      } as NodeJS.ProcessEnv),
    ).toThrow(/SESSION_SECRET/);
    try {
      loadDashboardConfig({
        VHALCHA_ENV: 'production',
        DATABASE_URL: 'postgres://vhalcha_app:secret@localhost:5432/vhalcha',
        KNOWLEDGE_STORAGE: 's3',
        KNOWLEDGE_S3_BUCKET: 'vhalcha-private',
        SESSION_SECRET: placeholder,
      } as NodeJS.ProcessEnv);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain(placeholder);
    }
  });

  it('accepts a long session secret and the application database role', () => {
    const config = loadDashboardConfig({
      VHALCHA_ENV: 'production',
      DATABASE_URL: 'postgres://vhalcha_app:secret@localhost:5432/vhalcha',
      KNOWLEDGE_STORAGE: 's3',
      KNOWLEDGE_S3_BUCKET: 'vhalcha-private',
      SESSION_SECRET: productionSecret,
    } as NodeJS.ProcessEnv);
    expect(config.SESSION_SECRET).toBe(productionSecret);
  });
});

describe('loadWorkerConfig', () => {
  it('requires the worker database role in production', () => {
    expect(() =>
      loadWorkerConfig({
        VHALCHA_ENV: 'production',
        DATABASE_URL: 'postgres://vhalcha_app:secret@localhost:5432/vhalcha',
        REDIS_URL: 'redis://localhost:6379',
        KNOWLEDGE_STORAGE: 's3',
        KNOWLEDGE_S3_BUCKET: 'vhalcha-private',
      } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
    const config = loadWorkerConfig({
      VHALCHA_ENV: 'production',
      DATABASE_URL: 'postgres://vhalcha_worker:secret@localhost:5432/vhalcha',
      REDIS_URL: 'redis://localhost:6379',
      KNOWLEDGE_STORAGE: 's3',
      KNOWLEDGE_S3_BUCKET: 'vhalcha-private',
    } as NodeJS.ProcessEnv);
    expect(config.DATABASE_URL).toContain('vhalcha_worker');
  });
});
