# DeepSeek for Copilot

Use DeepSeek V4 models directly in VS Code's Copilot Chat.

## But How!?

1. Install this extension
2. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Run `DeepSeek: Set API Key`
4. Enter your API key from [platform.deepseek.com](https://platform.deepseek.com)

## Usage

Open Copilot Chat and pick a DeepSeek model from the model selector:

- **DeepSeek V4 Flash**
- **DeepSeek V4 Flash Thinking**
- **DeepSeek V4 Pro**
- **DeepSeek V4 Pro Thinking**

That's it. Chat away.

## Requirements

- VS Code 1.108 or later
- GitHub Copilot subscription
- DeepSeek API key

## DeepSeek API Notes

This extension uses the current DeepSeek V4 API model IDs:

- `deepseek-v4-flash`
- `deepseek-v4-pro`

The older `deepseek-chat` and `deepseek-reasoner` aliases are deprecated by DeepSeek and scheduled to stop working on 2026-07-24.

## Settings

| Setting | Description |
|---------|-------------|
| `deepseek.apiKey` | API key (use the command instead for secure storage) |
| `deepseek.baseUrl` | API endpoint, defaults to `https://api.deepseek.com` |

## License

MIT
