import { runProviderSmoke } from './smoke.js';

const provider = process.argv[2] as 'openai' | 'anthropic' | 'google';
const config = {
  openai: { provider: 'openai' as const, model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
  anthropic: { provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  google: { provider: 'google' as const, model: 'gemini-2.5-flash', apiKeyEnv: 'GOOGLE_API_KEY' },
}[provider];

if (!config) {
  console.error('Usage: tsx src/smoke-cli.ts <openai|anthropic|google>');
  process.exit(2);
}

try {
  await runProviderSmoke(config);
  console.log(`smoke ${provider} PASS`);
  process.exit(0);
} catch (error) {
  console.error(`smoke ${provider} FAIL: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
