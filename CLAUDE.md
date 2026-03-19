# CLAUDE.md — AI Assistant Guide for ErrorVis

## Project Overview

**ErrorVis** is a VSCode extension for Rust developers that provides visual navigation of `Result` and `Option` error handling. It adds CodeLens badges above functions returning `Result<T>` or `Option<T>`, and enables a "Find Result Usages" command that shows all locations where those values are unwrapped, propagated, or matched.

- **Publisher:** Justin-P-web
- **Language:** TypeScript 5.3+
- **Target Language:** Rust (extension analyses Rust source files)
- **VSCode Engine:** ^1.85.0
- **License:** MIT

---

## Repository Structure

```
ErrorVis/
├── src/
│   ├── extension.ts        # Entry point — activate/deactivate, command registration, quick-pick UI
│   ├── codeLensProvider.ts # CodeLens provider — detects Result/Option-returning functions, shows badge counts
│   └── resultFinder.ts     # Core search logic — LSP-based + regex fallback, pattern classification
├── out/                    # Compiled JavaScript output (gitignored)
├── .vscode/
│   ├── launch.json         # VS Code debugger configuration
│   └── tasks.json          # Build task configuration
├── package.json            # Extension manifest, scripts, activation events
├── tsconfig.json           # TypeScript compiler config (strict, ES2020, CommonJS)
├── .vscodeignore           # Files excluded from packaged extension
├── README.md               # User-facing documentation
└── LICENSE                 # MIT
```

---

## Development Workflow

### Build Commands

```bash
npm run compile         # One-time TypeScript build → ./out/
npm run watch           # Watch mode (rebuild on save)
npm run vscode:prepublish  # Pre-publish build (same as compile)
npm run lint            # ESLint on ./src/**/*.ts
```

### Run/Debug

Use **F5** in VSCode to launch the Extension Development Host with the current build. The debugger config is in `.vscode/launch.json` (task: `npm: watch`).

### Testing

There is currently **no automated test suite**. All testing is manual:
1. Run `npm run compile`
2. Press F5 to open Extension Development Host
3. Open a Rust project in the new window
4. Verify CodeLens badges appear over `Result`/`Option` functions
5. Right-click and run "Find Result Usages"

When adding tests in the future, prefer `@vscode/test-electron` with Mocha (the standard VSCode extension test framework).

### Publishing

```bash
npm run vscode:prepublish   # Build before packaging
vsce package                # Produce .vsix
vsce publish                # Publish to VS Code Marketplace
```

---

## Architecture

### Module Responsibilities

| File | Responsibility |
|---|---|
| `extension.ts` | VSCode lifecycle (`activate`/`deactivate`), command registration, configuration listeners, `showResultPicker()` quick-pick UI |
| `codeLensProvider.ts` | `ResultCodeLensProvider` — scans open Rust documents for `fn` signatures returning `Result<T>`/`Option<T>`, provides/resolves CodeLens with usage counts |
| `resultFinder.ts` | `findHandlingLocations()` and `findHandlingTree()` — two-tier search (LSP references → regex fallback), `classifyLine()` pattern matcher |

### Two-Tier Search Strategy (`resultFinder.ts`)

1. **LSP (rust-analyzer):** Calls `vscode.executeReferenceProvider` to get cross-file references. Accurate but requires rust-analyzer to be active.
2. **Regex fallback:** If LSP returns no results, scans the current document with `symbol.replace(...)` escaped patterns. Single-file only but always available.

### Error-Handling Classification

`classifyLine()` categorises a line containing the symbol into one of 10 handling types:

| Type | Pattern |
|---|---|
| `unwrap` | `.unwrap()` |
| `expect` | `.expect(msg)` |
| `unwrap_or` | `.unwrap_or*()` variants |
| `map_combinator` | `.map()`, `.and_then()`, `.or()`, etc. |
| `question_mark` | `?` operator (propagates) |
| `return` | `return expr` (propagates) |
| `match` | `match` expressions |
| `if_let` | `if let` patterns |
| `while_let` | `while let` patterns |
| `check` | `.is_ok()` / `.is_err()` |

### Recursive Tree Traversal (`findHandlingTree`)

- Max recursion depth: `MAX_DEPTH = 10`
- Follows propagating patterns (`question_mark`, `return`) into calling functions
- Returns a tree structure for the quick-pick UI

---

## Code Conventions

### Naming

- **Classes:** PascalCase — `ResultCodeLensProvider`
- **Functions:** camelCase — `findHandlingTree`, `showResultPicker`
- **Constants / regex patterns:** UPPER_SNAKE_CASE — `FN_SIGNATURE`, `RETURNS_RESULT`, `MAX_DEPTH`
- **Private members:** underscore prefix — `_onDidChangeCodeLenses`, `_resolving`

### TypeScript Style

- Strict mode enabled (`"strict": true` in `tsconfig.json`)
- ES6 imports: `import * as vscode from 'vscode'`
- Module system: CommonJS (`"module": "commonjs"`)
- Target: ES2020

### Regex Safety

Always escape user/symbol input before embedding in regex patterns:

```typescript
symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
```

### File Organization

- Each file has a single clear responsibility
- Module-level constants (regex patterns) at the top
- Utility/helper functions grouped at the bottom of each file
- No barrel/index files needed (only 3 source files)

---

## Key Extension Points

### Adding a New Handling Pattern

1. Add a new entry to the `HandlingType` union type (or enum) in `resultFinder.ts`
2. Add the corresponding regex branch in `classifyLine()`
3. Add an icon/label for the new type in the quick-pick display logic in `extension.ts`

### Adding a New Language

The extension activates on `onLanguage:rust`. To support another language:

1. Add the language to `activationEvents` in `package.json`
2. Update `codeLensProvider.ts` document selector to include the new language
3. Adapt regex patterns in `resultFinder.ts` for the new language's syntax

### Configuration

The only user-facing setting is:

```json
"errorvis.enableCodeLens": true  // boolean, default true
```

Read in `extension.ts` via `vscode.workspace.getConfiguration('errorvis').get('enableCodeLens')`. Configuration changes are detected via `vscode.workspace.onDidChangeConfiguration`.

---

## Dependencies

**Runtime:** None — relies solely on the VSCode Extension API (no third-party runtime deps).

**Dev:**
- `typescript@^5.3.0`
- `@types/vscode@^1.85.0`
- `@types/node@^20.0.0`

**Recommended for users:** rust-analyzer (enables cross-file LSP references; without it, the regex fallback handles single-file search only).

---

## Git Conventions

- Feature branches merged to `master` via pull requests
- Commit messages are imperative and descriptive (e.g., "Fix build error: export findHandlingLocations")
- The `out/` directory is gitignored — always run `npm run compile` after cloning before debugging

---

## Common Tasks for AI Assistants

- **Adding a new pattern type:** Edit `classifyLine()` in `resultFinder.ts` and the display mapping in `extension.ts`.
- **Changing CodeLens appearance:** Edit `ResultCodeLensProvider` in `codeLensProvider.ts`.
- **Modifying the quick-pick UI:** Edit `showResultPicker()` in `extension.ts`.
- **Debugging search accuracy:** The two-tier search is in `findHandlingLocations()` in `resultFinder.ts`.
- **Building:** Always run `npm run compile` before testing; the extension loads from `./out/`, not `./src/`.
