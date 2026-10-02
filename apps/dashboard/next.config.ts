import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '20mb',
    },
  },
  transpilePackages: [
    '@vhalcha/audit',
    '@vhalcha/auth',
    '@vhalcha/config',
    '@vhalcha/database',
    '@vhalcha/knowledge',
    '@vhalcha/logger',
    '@vhalcha/policies',
    '@vhalcha/redis',
    '@vhalcha/routing',
    '@vhalcha/security',
    '@vhalcha/types',
  ],
  serverExternalPackages: ['pg', 'pino', 'thread-stream', 'ioredis', '@sentry/node'],
};

export default nextConfig;
