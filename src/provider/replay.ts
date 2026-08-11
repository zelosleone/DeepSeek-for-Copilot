import * as vscode from 'vscode';

/**
 * VS Code round-trips data parts with this MIME back to the provider on the next
 * turn (CustomDataPartMimeTypes.StatefulMarker in the Copilot integration). We use
 * it to carry a turn's reasoning inside the conversation itself, so it can never
 * leak into an unrelated chat session.
 */
const REPLAY_MARKER_MIME = 'stateful_marker';

/** Other extensions write markers with the same MIME; only read back our own. */
const REPLAY_MARKER_WRITER_ID = 'deepseek-for-copilot';

const SEPARATOR = '\\';

export function createReasoningMarkerPart(reasoningText: string): vscode.LanguageModelDataPart {
  const payload = JSON.stringify({ reasoningText });
  return new vscode.LanguageModelDataPart(
    new TextEncoder().encode(`${REPLAY_MARKER_WRITER_ID}${SEPARATOR}${payload}`),
    REPLAY_MARKER_MIME,
  );
}

export function readReasoningMarker(
  message: vscode.LanguageModelChatRequestMessage,
): string | undefined {
  for (const part of message.content) {
    if (!(part instanceof vscode.LanguageModelDataPart)) continue;
    if (part.mimeType !== REPLAY_MARKER_MIME) continue;

    const decoded = new TextDecoder().decode(part.data);
    const separatorIndex = decoded.indexOf(SEPARATOR);
    if (separatorIndex < 0) continue;
    if (decoded.slice(0, separatorIndex) !== REPLAY_MARKER_WRITER_ID) continue;

    try {
      const parsed: unknown = JSON.parse(decoded.slice(separatorIndex + 1));
      const text = (parsed as { reasoningText?: unknown })?.reasoningText;
      if (typeof text === 'string' && text.length > 0) return text;
    } catch {
      // Malformed marker: fall through and treat this turn as having no reasoning.
    }
  }
  return undefined;
}
