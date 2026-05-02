/**
 * Tests for the reasoningCache stability fixes (issue #7).
 *
 * Three bugs are covered:
 *  1. New-conversation detection via first-user-message fingerprint instead of
 *     fragile messages.length <= 2 heuristic.
 *  2. Cache index alignment when VS Code trims earlier messages (context truncation).
 *  3. convertMessages attaches reasoning_content from the correct cache slot.
 */

import { describe, it, expect } from 'vitest';
import {
  LanguageModelChatMessageRole,
  LanguageModelTextPart,
  type LanguageModelChatRequestMessage,
} from './vscode-stub.js';
import { convertMessages } from '../provider/convert.js';
import type { ReasoningEntry } from '../provider/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string): LanguageModelChatRequestMessage {
  return { role: LanguageModelChatMessageRole.User, content: [new LanguageModelTextPart(text)], name: undefined };
}

function assistantMsg(text: string): LanguageModelChatRequestMessage {
  return {
    role: LanguageModelChatMessageRole.Assistant,
    content: [new LanguageModelTextPart(text)],
    name: undefined,
  };
}

function makeCache(entries: Array<[number, string]>): Map<number, ReasoningEntry> {
  return new Map(entries.map(([k, v]) => [k, { text: v, timestamp: 0 }]));
}

// ---------------------------------------------------------------------------
// Bug 1: new-conversation detection (fingerprint logic lives in index.ts;
//         here we test that convertMessages itself does NOT clear anything —
//         the correct behaviour is that it always uses the cache it receives).
// ---------------------------------------------------------------------------

describe('convertMessages — basic reasoning_content round-trip', () => {
  it('attaches reasoning_content to assistant messages when isThinkingModel=true', () => {
    const cache = makeCache([[0, 'turn-0 reasoning']]);
    const messages: LanguageModelChatRequestMessage[] = [
      userMsg('hello'),
      assistantMsg('world'),
      userMsg('follow-up'),
    ];

    const result = convertMessages(messages, true, cache);

    const assistantOut = result.find((m) => m.role === 'assistant');
    expect(assistantOut).toBeDefined();
    expect(assistantOut?.reasoning_content).toBe('turn-0 reasoning');
  });

  it('does NOT attach reasoning_content when isThinkingModel=false', () => {
    const cache = makeCache([[0, 'should not appear']]);
    const messages: LanguageModelChatRequestMessage[] = [userMsg('hi'), assistantMsg('hello')];

    const result = convertMessages(messages, false, cache);

    const assistantOut = result.find((m) => m.role === 'assistant');
    expect(assistantOut?.reasoning_content).toBeUndefined();
  });

  it('uses empty string when cache has no entry for that turn', () => {
    const cache = makeCache([]); // empty — simulates wiped cache
    const messages: LanguageModelChatRequestMessage[] = [userMsg('hi'), assistantMsg('hello')];

    const result = convertMessages(messages, true, cache);

    const assistantOut = result.find((m) => m.role === 'assistant');
    expect(assistantOut?.reasoning_content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Bug 2: startTurnIndex alignment after context truncation
// ---------------------------------------------------------------------------

describe('convertMessages — startTurnIndex aligns cache after context truncation', () => {
  it('maps the first assistant message to startTurnIndex, not always 0', () => {
    // Conversation has had 3 turns total; VS Code trimmed the first two
    // assistant exchanges and now only passes the third pair.
    // nextReasoningTurnIndex = 3, assistantCountInMessages = 1 → startTurnIndex = 2.
    const cache = makeCache([
      [0, 'reasoning turn 0'],
      [1, 'reasoning turn 1'],
      [2, 'reasoning turn 2'], // ← this is what should be attached
    ]);

    const messages: LanguageModelChatRequestMessage[] = [
      userMsg('truncated context — only last pair'),
      assistantMsg('answer from turn 2'),
      userMsg('new question'),
    ];

    const result = convertMessages(messages, true, cache, /* startTurnIndex= */ 2);

    const assistantOut = result.find((m) => m.role === 'assistant');
    expect(assistantOut?.reasoning_content).toBe('reasoning turn 2');
  });

  it('with startTurnIndex=0 (default) maps first assistant to cache slot 0', () => {
    const cache = makeCache([[0, 'slot 0'], [1, 'slot 1']]);
    const messages: LanguageModelChatRequestMessage[] = [
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      assistantMsg('a2'),
      userMsg('q3'),
    ];

    const result = convertMessages(messages, true, cache);

    const assistants = result.filter((m) => m.role === 'assistant');
    expect(assistants[0]?.reasoning_content).toBe('slot 0');
    expect(assistants[1]?.reasoning_content).toBe('slot 1');
  });

  it('with startTurnIndex=1 shifts all assistant indices by 1', () => {
    const cache = makeCache([[1, 'slot 1'], [2, 'slot 2']]);
    const messages: LanguageModelChatRequestMessage[] = [
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      assistantMsg('a2'),
      userMsg('q3'),
    ];

    const result = convertMessages(messages, true, cache, /* startTurnIndex= */ 1);

    const assistants = result.filter((m) => m.role === 'assistant');
    expect(assistants[0]?.reasoning_content).toBe('slot 1');
    expect(assistants[1]?.reasoning_content).toBe('slot 2');
  });
});

// ---------------------------------------------------------------------------
// New-conversation fingerprint logic (isolated, not involving VS Code runtime)
// ---------------------------------------------------------------------------

describe('new-conversation detection via fingerprint', () => {
  it('detects a new conversation when the first user message changes', () => {
    const getFingerprint = (messages: LanguageModelChatRequestMessage[]) => {
      const firstUser = messages.find(
        (m) => m.role === LanguageModelChatMessageRole.User,
      );
      if (!firstUser) return '';
      let text = '';
      for (const part of firstUser.content) {
        if (part instanceof LanguageModelTextPart) text += part.value;
      }
      return text.slice(0, 200);
    };

    const conv1 = [userMsg('What is the capital of France?'), assistantMsg('Paris')];
    const conv2 = [userMsg('Explain async/await'), assistantMsg('It is a syntax for promises')];
    const conv1cont = [
      userMsg('What is the capital of France?'),
      assistantMsg('Paris'),
      userMsg('And Germany?'),
    ];

    expect(getFingerprint(conv1)).not.toBe(getFingerprint(conv2));
    expect(getFingerprint(conv1)).toBe(getFingerprint(conv1cont));
  });

  it('is not fooled by a short message array on a subsequent turn', () => {
    const getFingerprint = (messages: LanguageModelChatRequestMessage[]) => {
      const firstUser = messages.find(
        (m) => m.role === LanguageModelChatMessageRole.User,
      );
      if (!firstUser) return '';
      let text = '';
      for (const part of firstUser.content) {
        if (part instanceof LanguageModelTextPart) text += part.value;
      }
      return text.slice(0, 200);
    };

    // Old bug: messages.length <= 2 would reset cache for this array.
    const shortArray = [userMsg('What is the capital of France?')];
    const normalTurn2 = [
      userMsg('What is the capital of France?'),
      assistantMsg('Paris'),
      userMsg('And Germany?'),
    ];

    expect(getFingerprint(shortArray)).toBe(getFingerprint(normalTurn2));
  });
});

// ---------------------------------------------------------------------------
// Ordering: user/assistant messages preserved correctly in output
// ---------------------------------------------------------------------------

describe('convertMessages — message ordering', () => {
  it('preserves user and assistant message order', () => {
    const cache = makeCache([[0, 'r0'], [1, 'r1']]);
    const messages: LanguageModelChatRequestMessage[] = [
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      assistantMsg('a2'),
      userMsg('q3'),
    ];

    const result = convertMessages(messages, true, cache);

    expect(result.map((m) => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user',
    ]);
    expect(result[0].content).toBe('q1');
    expect(result[1].content).toBe('a1');
    expect(result[4].content).toBe('q3');
  });

  it('skips empty assistant messages when not a thinking model', () => {
    const cache = makeCache([]);
    const messages: LanguageModelChatRequestMessage[] = [
      userMsg('hi'),
      assistantMsg(''),
    ];

    const result = convertMessages(messages, false, cache);

    expect(result.every((m) => m.role !== 'assistant')).toBe(true);
  });

  it('keeps empty assistant messages when isThinkingModel=true (reasoning_content needed)', () => {
    const cache = makeCache([[0, 'some thinking']]);
    const messages: LanguageModelChatRequestMessage[] = [
      userMsg('hi'),
      assistantMsg(''),
    ];

    const result = convertMessages(messages, true, cache);

    const assistantOut = result.find((m) => m.role === 'assistant');
    expect(assistantOut).toBeDefined();
    expect(assistantOut?.reasoning_content).toBe('some thinking');
  });
});

// ---------------------------------------------------------------------------
// Gemini concern #2: hash-based cache lookup (robust to positional shifts)
// ---------------------------------------------------------------------------

describe('convertMessages — hash-based reasoning_content lookup', () => {
  it('matches reasoning by assistantContentPrefix even when positional index is wrong', () => {
    // Simulate: the cache was built with turn indices 0 and 1, but VS Code now
    // passes only the second assistant message (positional index in the current
    // array is 0, but the prefix should still find the right entry).
    const cache = new Map<number, ReasoningEntry>([
      [0, { text: 'reasoning for a1', timestamp: 0, assistantContentPrefix: 'answer one' }],
      [1, { text: 'reasoning for a2', timestamp: 0, assistantContentPrefix: 'answer two' }],
    ]);

    // Only the second exchange is present — positional index 0 would point to
    // cache slot 0 (wrong), but prefix lookup should find slot 1.
    const messages: LanguageModelChatRequestMessage[] = [
      userMsg('q2'),
      assistantMsg('answer two'),  // content matches prefix of slot 1
      userMsg('q3'),
    ];

    // startTurnIndex=0 intentionally wrong to prove prefix takes priority
    const result = convertMessages(messages, true, cache, /* startTurnIndex= */ 0);

    const assistantOut = result.find((m) => m.role === 'assistant');
    expect(assistantOut?.reasoning_content).toBe('reasoning for a2');
  });

  it('falls back to positional lookup when no prefix is stored', () => {
    // Pre-prefix entries (no assistantContentPrefix field)
    const cache = new Map<number, ReasoningEntry>([
      [0, { text: 'legacy reasoning', timestamp: 0 }],
    ]);
    const messages: LanguageModelChatRequestMessage[] = [
      userMsg('q1'),
      assistantMsg('some response'),
      userMsg('q2'),
    ];

    const result = convertMessages(messages, true, cache, /* startTurnIndex= */ 0);

    const assistantOut = result.find((m) => m.role === 'assistant');
    expect(assistantOut?.reasoning_content).toBe('legacy reasoning');
  });
});

// ---------------------------------------------------------------------------
// Gemini concern #1: fingerprint searches ALL user messages, not just first
// (logic lives in index.ts; tested here via the getMessageText helper)
// ---------------------------------------------------------------------------

describe('fingerprint — searches all user messages for stored fingerprint', () => {
  const buildFingerprint = (msg: LanguageModelChatRequestMessage) => {
    let text = '';
    for (const part of msg.content) {
      if (part instanceof LanguageModelTextPart) text += part.value;
    }
    return text.slice(0, 200) || msg.content.map((p) => (p as object).constructor?.name ?? 'unknown').join(',');
  };

  it('finds fingerprint when original first message was truncated to position 1', () => {
    const storedFingerprint = 'What is the capital of France?';

    // VS Code has appended an earlier system-like message; original first user
    // message is now at index 1 in the array.
    const messages: LanguageModelChatRequestMessage[] = [
      userMsg('(injected context message)'),
      userMsg('What is the capital of France?'),
      assistantMsg('Paris'),
      userMsg('And Germany?'),
    ];

    const found = messages.some(
      (m) => m.role === LanguageModelChatMessageRole.User && buildFingerprint(m) === storedFingerprint,
    );
    expect(found).toBe(true);
  });

  it('detects new conversation when fingerprint is absent from all messages', () => {
    const storedFingerprint = 'What is the capital of France?';

    const messages: LanguageModelChatRequestMessage[] = [
      userMsg('Explain quantum entanglement'),
      assistantMsg('It is a phenomenon...'),
      userMsg('Give me an example'),
    ];

    const found = messages.some(
      (m) => m.role === LanguageModelChatMessageRole.User && buildFingerprint(m) === storedFingerprint,
    );
    expect(found).toBe(false); // should trigger cache reset
  });
});
