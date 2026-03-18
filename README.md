# ErrorVis: Result Unwrap Navigator

A VSCode extension for Rust that shows where `Result` and `Option` values are handled across your codebase.

## Features

### CodeLens annotations

Above every function that returns `Result<…>` or `Option<…>`, ErrorVis shows an inline count of how many times the return value is handled:

```
$(references) 3 result usages handled
fn fetch_data(...) -> Result<Data, Error> {
```

Clicking the lens opens the usage picker (see below).

### Find Result Usages command

Place your cursor on any `Result`/`Option` variable or function name, then run **ErrorVis: Find Result Usages** from the command palette or the right-click context menu. A quick-pick list appears showing every handling site, categorised by kind:

| Icon | Kind |
|------|------|
| `$(error)` | `.unwrap()` |
| `$(warning)` | `.expect(…)` |
| `$(symbol-method)` | `.unwrap_or*(…)` |
| `$(symbol-method)` | combinator (`.map`, `.and_then`, `.or`, etc.) |
| `$(symbol-operator)` | `?` operator |
| `$(symbol-enum)` | `match` |
| `$(symbol-keyword)` | `if let` |
| `$(symbol-keyword)` | `while let` |
| `$(symbol-boolean)` | `.is_ok()` / `.is_err()` |

As you move through the list, the editor previews each site. Pressing Enter jumps to it; pressing Escape returns you to your original position.

## Requirements

- VSCode 1.85 or later
- A Rust file open in the editor (the extension activates on `onLanguage:rust`)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) is recommended for cross-file navigation (the extension falls back to a regex scan of the current file when the LSP is unavailable)

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `errorvis.enableCodeLens` | `true` | Show CodeLens annotations above `Result`/`Option`-returning functions |

## Usage

1. Open a Rust file.
2. CodeLens counts appear automatically above qualifying functions.
3. Click a lens **or** place the cursor on a symbol and run **ErrorVis: Find Result Usages** (`Ctrl+Shift+P` → `ErrorVis: Find Result Usages`).
4. Browse the usage list; the editor previews each location as you move.
5. Press `Enter` to jump, or `Escape` to cancel and return to your original position.

## How It Works

Usage discovery runs in two tiers:

1. **LSP (rust-analyzer)** — `vscode.executeReferenceProvider` returns all references across the workspace. Each reference line is classified by pattern matching.
2. **Regex fallback** — when the LSP returns no results, the current document is scanned line-by-line with the same classifier.

The classifier checks each line against patterns for `?`, `match`, `if let`, `while let`, method chains (`.unwrap`, `.expect`, `.map`, etc.), and boolean checks (`.is_ok`, `.is_err`).

## License

See [LICENSE](LICENSE).
