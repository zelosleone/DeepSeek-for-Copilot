# DeepSeek for Copilot

Use DeepSeek models in GitHub Copilot Chat, plus optional inline code completions.

1. Run **DeepSeek: Set API Key** and paste a key from [platform.deepseek.com](https://platform.deepseek.com), or add it under **Manage Models** in the Copilot Chat model picker.
2. Pick a DeepSeek model in the model picker.
3. Set reasoning effort and temperature right in the picker.

Models, context windows and effort levels come live from DeepSeek's API, with [models.dev](https://models.dev) filling any gaps, so new models show up without an update. Copilot's context window indicator works as usual.

## Model picker

| Option | Values |
|---|---|
| Reasoning Effort | Live per model, currently Off, Low, High and Max. Starts at DeepSeek's own default. |
| Temperature | Balanced (1.0), Precise (0.2), Creative (1.3), Max (1.5) or Custom |

## Inline completion

Off by default. Run **DeepSeek: Toggle Inline Completion**, and turn off Copilot's own inline suggestions (`github.copilot.enable`) so the two don't compete.

Suggestions come from DeepSeek Flash. A tree-sitter parse trims them at the end of the block they started in, or after one statement when they start new ones. Grammars ship for TypeScript, JavaScript, Python, Go, Rust, Java, C#, C/C++, Ruby, PHP, shell, PowerShell, CSS and INI; other languages are only capped by `maxLines`.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `deepseek.baseUrl` | `https://api.deepseek.com` | API base URL |
| `deepseek.temperature` | `1` | Used when the picker's temperature is Custom |
| `deepseek.apiKey` | empty | Plain-text fallback; **Set API Key** stores the key securely instead |
| `deepseek.inlineCompletion.enabled` | `false` | Inline completion on or off |
| `deepseek.inlineCompletion.debounceMs` | `300` | Idle time before a request is sent |
| `deepseek.inlineCompletion.maxTokens` | `128` | Tokens per suggestion, up to 4096 |
| `deepseek.inlineCompletion.maxLines` | `10` | Lines per suggestion |

## Commands

All under **DeepSeek:** in the Command Palette: Set API Key, Clear API Key, Set Temperature, Toggle Inline Completion, Open Settings, and Show Logs (token counts and cache hit rate).

## Builds

Install from the Marketplace or a release `.vsix`. Releases also attach a `-nes.vsix` with proposed inline-completion APIs for sideloading; it needs `{ "enable-proposed-api": ["DenizhanDaklr.copilot-vscode-deepseek"] }` in `~/.vscode/argv.json`. Build locally with `npm run package` or `npm run package:proposed`.

Requires VS Code 1.125+ and GitHub Copilot Chat. MIT license.
