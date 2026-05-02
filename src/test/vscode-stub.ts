// Minimal vscode stub for unit tests — only the surface used by convert.ts.

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public readonly callId: string,
    public readonly name: string,
    public readonly input: unknown,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public readonly callId: string,
    public readonly content: readonly unknown[],
  ) {}
}

export interface LanguageModelChatRequestMessage {
  role: LanguageModelChatMessageRole;
  content: readonly unknown[];
  name: string | undefined;
}
