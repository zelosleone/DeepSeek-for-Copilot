# DeepSeek for Copilot

Use DeepSeek models directly in VS Code's Copilot Chat.

## But How!?

1. Install this extension
2. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Run `DeepSeek: Set API Key`
4. Enter your API key from [platform.deepseek.com](https://platform.deepseek.com)

## Usage

Open Copilot Chat and pick a DeepSeek model from the model selector:

- **DeepSeek Chat** — Fast, general-purpose model with tool support
- **DeepSeek Reasoner** — Thinking model for complex problems

That's it. Chat away.

## Requirements

- VS Code 1.104 or later
- GitHub Copilot subscription
- DeepSeek API key

## Settings

| Setting | Description |
|---------|-------------|
| `deepseek.apiKey` | API key (use the command instead for secure storage) |
| `deepseek.baseUrl` | API endpoint, defaults to `https://api.deepseek.com` |

## License

MIT
