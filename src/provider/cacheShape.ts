import type { DeepSeekMessage, DeepSeekTool } from '../deepseekClient.js';

/**
 * Hashes the parts of a request that decide whether DeepSeek can reuse its prompt
 * cache. Comparing consecutive snapshots explains *why* a request missed, instead
 * of leaving a bare hit rate to interpret. Modelled on Reasonix's PrefixShape.
 */
export interface PrefixShape {
  /** The leading user message, which is where Copilot puts its system prompt. */
  systemHash: string;
  toolsHash: string;
  toolCount: number;
  /** Assistant turns carrying replayed reasoning; losing one rewrites the prefix. */
  reasoningTurns: number;
}

/** FNV-1a. Only used to detect change, so cryptographic strength is irrelevant. */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function captureShape(
  messages: readonly DeepSeekMessage[],
  tools: readonly DeepSeekTool[] | undefined,
): PrefixShape {
  return {
    systemHash: hash(messages[0]?.content ?? ''),
    toolsHash: hash(JSON.stringify(tools ?? [])),
    toolCount: tools?.length ?? 0,
    reasoningTurns: messages.filter((m) => m.reasoning_content).length,
  };
}

/**
 * What changed between two turns, most cache-destructive first. An empty result
 * means the prefix was stable and any miss came from the tail or from TTL expiry.
 */
export function describeShapeChange(previous: PrefixShape, current: PrefixShape): string[] {
  const reasons: string[] = [];
  if (previous.systemHash !== current.systemHash) reasons.push('system-prompt-changed');
  if (previous.toolsHash !== current.toolsHash) {
    reasons.push(
      previous.toolCount === current.toolCount
        ? 'tools-changed'
        : `tools-count ${previous.toolCount}->${current.toolCount}`,
    );
  }
  if (previous.reasoningTurns > current.reasoningTurns) reasons.push('reasoning-replay-lost');
  return reasons;
}
