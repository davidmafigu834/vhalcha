import { describe, expect, it } from 'vitest';
import { splitChatMessages } from './messages';

describe('splitChatMessages', () => {
  it('lifts a single system message', () => {
    expect(
      splitChatMessages([
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hello' },
      ]),
    ).toEqual({
      system: 'Be brief.',
      turns: [{ role: 'user', text: 'hello' }],
    });
  });

  it('preserves multi-turn order', () => {
    expect(
      splitChatMessages([
        { role: 'system', content: 'Rules' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Again' },
      ]),
    ).toEqual({
      system: 'Rules',
      turns: [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello' },
        { role: 'user', text: 'Again' },
      ],
    });
  });

  it('joins multiple system messages', () => {
    expect(
      splitChatMessages([
        { role: 'system', content: 'Knowledge block' },
        { role: 'system', content: 'App instructions' },
        { role: 'user', content: 'Ask' },
      ]),
    ).toEqual({
      system: 'Knowledge block\n\nApp instructions',
      turns: [{ role: 'user', text: 'Ask' }],
    });
  });

  it('merges consecutive user turns', () => {
    expect(
      splitChatMessages([
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
      ]),
    ).toEqual({
      system: '',
      turns: [{ role: 'user', text: 'one\ntwo' }],
    });
  });

  it('merges consecutive assistant turns', () => {
    expect(
      splitChatMessages([
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
      ]),
    ).toEqual({
      system: '',
      turns: [{ role: 'assistant', text: 'a\nb' }],
    });
  });

  it('allows assistant-first history', () => {
    expect(
      splitChatMessages([
        { role: 'assistant', content: 'Earlier' },
        { role: 'user', content: 'Next' },
      ]),
    ).toEqual({
      system: '',
      turns: [
        { role: 'assistant', text: 'Earlier' },
        { role: 'user', text: 'Next' },
      ],
    });
  });

  it('keeps empty content', () => {
    expect(splitChatMessages([{ role: 'user', content: '' }])).toEqual({
      system: '',
      turns: [{ role: 'user', text: '' }],
    });
  });

  it('keeps knowledge and application systems as system text', () => {
    const split = splitChatMessages([
      { role: 'system', content: 'VHALCHA APPROVED KNOWLEDGE\n[S1] policy' },
      { role: 'system', content: 'Answer briefly.' },
      { role: 'user', content: 'What is the policy?' },
    ]);
    expect(split.system).toContain('VHALCHA APPROVED KNOWLEDGE');
    expect(split.system).toContain('Answer briefly.');
    expect(split.turns).toEqual([{ role: 'user', text: 'What is the policy?' }]);
  });
});
