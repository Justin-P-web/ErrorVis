# ErrorVis: Result Unwrap Navigator

A VSCode extension for Rust that shows where `Result` and `Option` values are handled across your codebase.

## Features

### CodeLens annotations

Above every function that returns `Result<…>` or `Option<…>`, ErrorVis shows an inline count of how many times the return value is handled:

```
$(references) 3 result usages handled
fn fetch_data(...) -> Result<Data, Error> {
```

Clicking the lens opens the usage picker (see below). While rust-analyzer is still indexing, the lens shows a spinner (`$(sync~spin) Waiting for rust-analyzer to index…`) and retries automatically for up to ~3 minutes.

### Find Result Usages command

Place your cursor on any `Result`/`Option` variable or function name, then run **ErrorVis: Find Result Usages** from the command palette or the right-click context menu. A quick-pick list appears showing every handling site, categorised by kind:

| Icon | Kind |
|------|------|
| `$(error)` | `.unwrap()` |
| `$(warning)` | `.expect(…)` |
| `$(symbol-method)` | `.unwrap_or*(…)` |
| `$(symbol-method)` | combinator (`.map`, `.and_then`, `.or`, `.ok`, `.err`, `.map_err`, `.flatten`, `.transpose`) |
| `$(symbol-operator)` | `?` operator |
| `$(arrow-right)` | `return` / implicit final expression |
| `$(symbol-enum)` | `match` |
| `$(symbol-keyword)` | `if let` |
| `$(symbol-keyword)` | `while let` |
| `$(symbol-boolean)` | `.is_ok()` / `.is_err()` |

Results are grouped by depth: direct usages appear first, then propagated usages (via `?` or `return`) at increasing depths, each labelled with the function they passed through. As you move through the list the editor previews each site. Pressing Enter jumps to it; pressing Escape returns you to your original position.

### Export Result Tree command

Run **ErrorVis: Export Result Tree** from the command palette to perform a workspace-wide analysis. You will be prompted for a save location; ErrorVis then writes three files simultaneously:

| File | Format | Content |
|------|--------|---------|
| `result-tree.json` | JSON | Structured `GlobalResultTree` — all groups, functions, and handling locations with kind, depth, propagation path, file, and line |
| `result-tree.md` | Markdown | Human-readable view grouped by struct/file, plus an inverted "handling by call site" table |
| `result-tree-<file>.mmd` | Mermaid flowchart | Per-file directed graph with coloured nodes: source functions (blue), pass-through functions (orange dashed), handler call sites (grey) |

After export you are offered buttons to open any of the generated files directly in the editor.

## Requirements

- VSCode 1.85 or later
- A Rust file open in the editor (the extension activates on `onLanguage:rust`)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) is **strongly recommended** for cross-file navigation — without it the extension falls back to a regex scan of the current file only

## Extension settings

| Setting | Default | Description |
|---------|---------|-------------|
| `errorvis.enableCodeLens` | `true` | Show CodeLens annotations above `Result`/`Option`-returning functions |

## Editor setup

### VSCode

1. Install the extension from the VS Code Marketplace (search **ErrorVis**) or install the `.vsix` manually via **Extensions → … → Install from VSIX**.
2. Open a Rust workspace. CodeLens counts appear automatically above qualifying functions once rust-analyzer has finished indexing.
3. **Find usages:** click a CodeLens badge, right-click a symbol and choose **ErrorVis: Find Result Usages**, or open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run the command.
4. **Export:** open the command palette and run **ErrorVis: Export Result Tree**; choose a save location when prompted.
5. To disable CodeLens without uninstalling the extension, set `errorvis.enableCodeLens` to `false` in your settings.

#### Suggested keybindings (VSCode)

Add to your `keybindings.json` (`Ctrl+Shift+P` → **Open Keyboard Shortcuts (JSON)**):

```json
[
  {
    "key": "ctrl+shift+u",
    "command": "errorvis.findResultUsages",
    "when": "editorLangId == rust && editorTextFocus"
  },
  {
    "key": "ctrl+shift+e",
    "command": "errorvis.exportResultTree",
    "when": "editorLangId == rust"
  }
]
```

---

### Neovim (via vscode-neovim)

ErrorVis is a VSCode extension and requires the VSCode host. If you use Neovim as your primary editor inside VSCode via the [vscode-neovim](https://marketplace.visualstudio.com/items?itemName=asvetliakov.vscode-neovim) extension, all ErrorVis features remain fully accessible.

#### Setup

1. Install [vscode-neovim](https://marketplace.visualstudio.com/items?itemName=asvetliakov.vscode-neovim) from the Marketplace.
2. Install ErrorVis as described in the VSCode section above.
3. Open a Rust workspace. CodeLens badges and all ErrorVis commands appear as normal.

#### Invoking commands from Neovim

VSCode commands can be called from Neovim via `vscode.call` (Lua) or `VSCodeCall` (Vimscript). Add the following to your `init.lua` (or equivalent) to create normal-mode mappings that mirror the VSCode keybindings:

**Lua (`init.lua`)**

```lua
-- Only active when the vscode global is present (i.e. running inside VSCode)
if vim.g.vscode then
  local vscode = require('vscode')

  -- Find Result Usages
  vim.keymap.set('n', '<leader>ru', function()
    vscode.call('errorvis.findResultUsages')
  end, { desc = 'ErrorVis: Find Result Usages' })

  -- Export Result Tree
  vim.keymap.set('n', '<leader>re', function()
    vscode.call('errorvis.exportResultTree')
  end, { desc = 'ErrorVis: Export Result Tree' })
end
```

**Vimscript (`init.vim`)**

```vim
if exists('g:vscode')
  " Find Result Usages
  nnoremap <leader>ru <Cmd>call VSCodeCall('errorvis.findResultUsages')<CR>
  " Export Result Tree
  nnoremap <leader>re <Cmd>call VSCodeCall('errorvis.exportResultTree')<CR>
endif
```

#### CodeLens in Neovim mode

vscode-neovim renders VSCode CodeLens decorations as virtual text above the relevant line, exactly as in standard VSCode editing. Clicking a lens with the mouse works as normal. To trigger a CodeLens entry from the keyboard without leaving Neovim mode, use the vscode-neovim `editor.action.triggerParameterHints` codelens action, or simply invoke `errorvis.findResultUsages` directly via the mappings above.

#### Notes

- The quick-pick picker that shows usage results is a native VSCode widget; it appears and behaves identically in vscode-neovim mode.
- Live preview of each usage site as you navigate the picker works without any extra configuration.
- The `Escape` key in the picker returns you to your original cursor position as expected, regardless of your Neovim `<Esc>` mappings, because the picker captures input directly.

---

## How it works

Usage discovery runs in two tiers:

1. **LSP (rust-analyzer)** — `vscode.executeReferenceProvider` returns all references across the workspace. Each reference line is classified by pattern matching.
2. **Regex fallback** — when the LSP returns no results, the current document is scanned line-by-line with the same classifier.

The classifier checks each line against patterns for `?`, `return` (explicit and implicit), `match`, `if let`, `while let`, method chains (`.unwrap`, `.expect`, `.map`, etc.), and boolean checks (`.is_ok`, `.is_err`). It handles dereference operators, namespace paths (`module::sub::fn`), and multi-level argument nesting.

For propagating patterns (`?` and `return`), the tree traversal follows the error upward into the enclosing function and repeats the search there, up to a maximum depth of 10 levels. Cycle detection prevents infinite loops. The `via` field in each result records which function the value passed through.

## License

See [LICENSE](LICENSE).
