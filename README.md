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

## Commands

| Command | What it does |
|---|---|
| `DeepSeek: Set API Key` | Store API key |
| `DeepSeek: Clear API Key` | Remove stored key |
| `DeepSeek: Show Logs` | Open output channel (token counts, cache hit rate) |

## Requirements

- VS Code 1.118+
- GitHub Copilot subscription
- DeepSeek API key

## License

MIT
