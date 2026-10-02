import type { NormalizedUsage } from './openai';

const encoder = new TextEncoder();

export function sseData(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sseText(text: string): Uint8Array {
  return sseData({ choices: [{ delta: { content: text } }] });
}

export function sseUsage(usage: NormalizedUsage): Uint8Array {
  return sseData({
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
    },
  });
}

export function sseDone(): Uint8Array {
  return encoder.encode('data: [DONE]\n\n');
}

export function completionBody(model: string, content: string, usage: NormalizedUsage | null) {
  return {
    id: 'chatcmpl-vhalcha',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
          },
        }
      : {}),
  };
}
