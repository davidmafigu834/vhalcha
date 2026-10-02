import type { ChatCompletionRequest } from '@vhalcha/types';

export interface TextTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** System text is lifted out of the vendor message list. Order of user and assistant turns is preserved. */
export function splitChatMessages(messages: ChatCompletionRequest['messages']): { system: string; turns: TextTurn[] } {
  const systemParts: string[] = [];
  const turns: TextTurn[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = turns[turns.length - 1];
    if (previous && previous.role === role) {
      previous.text = `${previous.text}\n${message.content}`;
      continue;
    }
    turns.push({ role, text: message.content });
  }
  return { system: systemParts.join('\n\n'), turns };
}
