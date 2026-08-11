# DeepSeek for Copilot

Use DeepSeek V4 models in Copilot Chat.

## Setup

1. Install the extension.
2. `Ctrl+Shift+P` → **DeepSeek: Set API Key** → enter your key from [platform.deepseek.com](https://platform.deepseek.com).
3. Open Copilot Chat, pick a DeepSeek model. Chat.

## Model Picker

Each model has a gear icon with two dropdowns:

| Setting | Options | Default |
|---|---|---|
| Thinking Effort | None, High, Max | High |
| Temperature | Balanced (1.0), Precise (0.2), Creative (1.3), Max (1.5) | Balanced |

No global settings needed, everything lives in the picker.

## Inline Completion

DeepSeek FIM suggestions as you type. Off by default.

`Ctrl+Shift+P` → **DeepSeek: Toggle Inline Completion**.

| Setting | Options | Default |
|---|---|---|
| `deepseek.inlineCompletion.enabled` | on, off | off |
| `deepseek.inlineCompletion.model` | `deepseek-v4-flash`, `deepseek-v4-pro` | flash |
| `deepseek.inlineCompletion.debounceMs` | idle time before a request | 300 |
| `deepseek.inlineCompletion.maxTokens` | tokens per suggestion | 128 |
| `deepseek.inlineCompletion.maxLines` | lines per suggestion | 10 |

Suggestions are cut where they leave the block they started in, and re-indented to
match the editor's tabs/spaces.

Turn off Copilot's own inline suggestions first (`github.copilot.enable`), otherwise
both providers compete for the same ghost text.

## Commands

| Command | What it does |
|---|---|
| `DeepSeek: Set API Key` | Store API key |
| `DeepSeek: Clear API Key` | Remove stored key |
| `DeepSeek: Set Temperature` | Pick a temperature preset or custom value |
| `DeepSeek: Toggle Inline Completion` | Turn FIM suggestions on or off |
| `DeepSeek: Open Settings` | Jump to the DeepSeek settings |
| `DeepSeek: Show Logs` | Open output channel (token counts, cache hit rate) |

## Requirements

- VS Code 1.125+
- GitHub Copilot subscription
- DeepSeek API key

## License

MIT
