-- Multi-provider routing: Anthropic and Google catalogue models, connection verification metadata.
-- Prices were verified against official provider documentation on 2026-09-29.
-- This migration UPDATEs existing OpenAI rates in place. It does not rely on ON CONFLICT DO NOTHING for price changes.

alter table provider_connections
  add column if not exists verification_error_code text,
  add column if not exists verified_at timestamptz,
  add column if not exists last_checked_at timestamptz;

insert into model_catalogue (
  id, provider, model_name, display_name, status, tier,
  input_usd_per_million, output_usd_per_million, cached_input_usd_per_million,
  context_window, max_output_tokens,
  capabilities, reasoning_level, latency_class,
  supports_tools, supports_vision, supports_structured_output, supports_streaming, supports_long_context,
  currency, price_effective_at, price_verified_at, price_source
) values
  (
    '88888888-8888-4888-8888-888888888881', 'anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'active', 'economy',
    1.000000, 5.000000, 0.100000,
    200000, 64000,
    '["chat","classification","extraction","summarization","structured_output"]'::jsonb, 'medium', 'fast',
    false, false, true, true, true,
    'USD', timestamptz '2025-10-01T00:00:00Z', now(),
    'Anthropic published Claude Haiku 4.5 rates (platform.claude.com/docs/en/about-claude/pricing), verified for Vhalcha on 2026-09-29. Cache read $0.10/MTok. Tool use is not claimed by the Vhalcha adapter.'
  ),
  (
    '88888888-8888-4888-8888-888888888882', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', 'active', 'premium',
    2.000000, 10.000000, 0.200000,
    1000000, 128000,
    '["chat","classification","extraction","summarization","reasoning","structured_output","long_context"]'::jsonb, 'high', 'normal',
    false, false, true, true, true,
    'USD', timestamptz '2026-08-10T00:00:00Z', now(),
    'Anthropic published Claude Sonnet 5 rates (platform.claude.com/docs/en/about-claude/pricing), verified for Vhalcha on 2026-09-29. Introductory $2/$10 became standard. Cache read $0.20/MTok. Tool use is not claimed by the Vhalcha adapter.'
  ),
  (
    '99999999-9999-4999-8999-999999999991', 'google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 'active', 'economy',
    0.300000, 2.500000, 0.030000,
    1048576, 65536,
    '["chat","classification","extraction","summarization","structured_output","long_context"]'::jsonb, 'medium', 'fast',
    false, false, true, true, true,
    'USD', timestamptz '2025-05-01T00:00:00Z', now(),
    'Google Gemini Developer API paid-tier text rates for gemini-2.5-flash (ai.google.dev/gemini-api/docs/pricing), verified for Vhalcha on 2026-09-29. Output includes thinking tokens. Cached input $0.03/MTok when reported. Tool and vision routing are not claimed by the Vhalcha text adapter.'
  ),
  (
    '99999999-9999-4999-8999-999999999992', 'google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 'active', 'premium',
    1.250000, 10.000000, 0.125000,
    1048576, 65536,
    '["chat","classification","extraction","summarization","reasoning","structured_output","long_context"]'::jsonb, 'high', 'normal',
    false, false, true, true, true,
    'USD', timestamptz '2025-05-01T00:00:00Z', now(),
    'Google Gemini Developer API paid-tier text rates for gemini-2.5-pro prompts <=200k (ai.google.dev/gemini-api/docs/pricing), verified for Vhalcha on 2026-09-29. Higher tier for prompts >200k is not modeled. Tool and vision routing are not claimed by the Vhalcha text adapter.'
  )
on conflict (provider, model_name) do update set
  display_name = excluded.display_name,
  status = excluded.status,
  tier = excluded.tier,
  input_usd_per_million = excluded.input_usd_per_million,
  output_usd_per_million = excluded.output_usd_per_million,
  cached_input_usd_per_million = excluded.cached_input_usd_per_million,
  context_window = excluded.context_window,
  max_output_tokens = excluded.max_output_tokens,
  capabilities = excluded.capabilities,
  reasoning_level = excluded.reasoning_level,
  latency_class = excluded.latency_class,
  supports_tools = excluded.supports_tools,
  supports_vision = excluded.supports_vision,
  supports_structured_output = excluded.supports_structured_output,
  supports_streaming = excluded.supports_streaming,
  supports_long_context = excluded.supports_long_context,
  currency = excluded.currency,
  price_effective_at = excluded.price_effective_at,
  price_verified_at = excluded.price_verified_at,
  price_source = excluded.price_source;

update model_catalogue set
  input_usd_per_million = 2.000000,
  output_usd_per_million = 8.000000,
  currency = 'USD',
  price_effective_at = timestamptz '2025-04-14T00:00:00Z',
  price_verified_at = now(),
  price_source = 'OpenAI published gpt-4.1 standard rates, re-verified for Vhalcha on 2026-09-29 against OpenAI pricing docs. Cached input is not applied by the Vhalcha adapter.'
where provider = 'openai' and model_name = 'gpt-4.1';

update model_catalogue set
  input_usd_per_million = 0.400000,
  output_usd_per_million = 1.600000,
  currency = 'USD',
  price_effective_at = timestamptz '2025-04-14T00:00:00Z',
  price_verified_at = now(),
  price_source = 'OpenAI published gpt-4.1-mini standard rates, re-verified for Vhalcha on 2026-09-29 against OpenAI pricing docs. Cached input is not applied by the Vhalcha adapter.'
where provider = 'openai' and model_name = 'gpt-4.1-mini';

update model_catalogue set
  input_usd_per_million = 2.500000,
  output_usd_per_million = 10.000000,
  currency = 'USD',
  price_effective_at = timestamptz '2024-08-06T00:00:00Z',
  price_verified_at = now(),
  price_source = 'OpenAI published gpt-4o standard rates, re-verified for Vhalcha on 2026-09-29 against OpenAI pricing docs. Cached input is not applied by the Vhalcha adapter.'
where provider = 'openai' and model_name = 'gpt-4o';

update model_catalogue set
  input_usd_per_million = 0.150000,
  output_usd_per_million = 0.600000,
  currency = 'USD',
  price_effective_at = timestamptz '2024-07-18T00:00:00Z',
  price_verified_at = now(),
  price_source = 'OpenAI published gpt-4o-mini standard rates, re-verified for Vhalcha on 2026-09-29 against OpenAI pricing docs. Cached input is not applied by the Vhalcha adapter.'
where provider = 'openai' and model_name = 'gpt-4o-mini';
