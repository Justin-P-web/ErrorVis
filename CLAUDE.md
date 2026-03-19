# CLAUDE.md — AI Assistant Guide for ErrorVis

## Project Overview

**ErrorVis** is a VSCode extension for Rust developers that provides visual navigation of `Result` and `Option` error handling. It adds CodeLens badges above functions returning `Result<T>` or `Option<T>`, and enables a "Find Result Usages" command that shows all locations where those values are unwrapped, propagated, or matched. A global "Export Result Tree" command lets users export a workspace-wide analysis to JSON or Markdown.

- **Publisher:** Justin-P-web
- **Version:** 0.2.1
- **Language:** TypeScript 5.3+
- **Target Language:** Rust (extension analyses Rust source files)
- **VSCode Engine:** ^1.85.0
- **License:** MIT

---

## Repository Structure

```
ErrorVis/
├── src/
│   ├── extension.ts          # Entry point — activate/deactivate, command registration, quick-pick UI, export
│   ├── codeLensProvider.ts   # CodeLens provider — detects Result/Option-returning functions, shows badge counts
│   ├── resultFinder.ts       # Core search logic — LSP-based + regex fallback, pattern classification, tree building
│   └── test/
│       ├── classifyLine.test.ts  # Unit tests for classifyLine() pattern matching (80+ cases)
│       ├── setup.ts              # Test setup — injects vscode mock before module loading
│       └── mocks/
│           └── vscode.ts         # Minimal vscode API mock for isolated unit testing
├── out/                      # Compiled JavaScript output (gitignored)
├── .vscode/
│   ├── launch.json           # VS Code debugger configuration
│   └── tasks.json            # Build task configuration (npm: watch)
├── .mocharc.json             # Mocha test runner configuration
├── package.json              # Extension manifest, scripts, activation events
├── tsconfig.json             # TypeScript compiler config (strict, ES2020, CommonJS)
├── tsconfig.test.json        # TypeScript config for tests (path maps vscode → mock)
├── .vscodeignore             # Files excluded from packaged extension
├── README.md                 # User-facing documentation
└── LICENSE                   # MIT (Copyright 2026 Justin Perkey)
```

---

## Development Workflow

### Build Commands

```bash
npm run compile            # One-time TypeScript build → ./out/
npm run watch              # Watch mode (rebuild on save)
npm run vscode:prepublish  # Pre-publish build (same as compile)
npm run lint               # ESLint on ./src/**/*.ts
npm test                   # Run unit tests with Mocha
```

### Run/Debug

Use **F5** in VSCode to launch the Extension Development Host with the current build. The debugger config is in `.vscode/launch.json` (pre-launch task: `npm: watch`).

### Testing

The project has a unit test suite for `classifyLine()` using Mocha and tsx.

```bash
npm test   # Runs: mocha (configured via .mocharc.json)
```

**Test configuration (`.mocharc.json`):**
- Requires: `tsx/cjs`, `src/test/setup.ts`
- Spec: `src/test/**/*.test.ts`
- Timeout: 5000ms

**Test structure:**
- `src/test/classifyLine.test.ts` — 80+ test cases covering all 10 handling patterns
- `src/test/setup.ts` — intercepts `require('vscode')` and routes to mock before any module loads
- `src/test/mocks/vscode.ts` — minimal stub providing `Uri`, `Position`, `Range`, `SymbolKind`, `commands`, `workspace`

**Running tests does NOT require VSCode to be open** — the mock allows isolated Node.js execution.

For integration testing, manual steps still apply:
1. Run `npm run compile`
2. Press F5 to open Extension Development Host
3. Open a Rust project
4. Verify CodeLens badges appear over `Result`/`Option` functions
5. Right-click and run "Find Result Usages"

When adding integration tests in the future, prefer `@vscode/test-electron` with Mocha.

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
| `extension.ts` | VSCode lifecycle (`activate`/`deactivate`), command registration, configuration listeners, `showResultPicker()` quick-pick UI, `exportResultTree()` JSON/Markdown export |
| `codeLensProvider.ts` | `ResultCodeLensProvider` — scans open Rust documents for `fn` signatures returning `Result<T>`/`Option<T>`, provides/resolves CodeLens with usage counts, exponential backoff retry |
| `resultFinder.ts` | `findHandlingLocations()`, `findHandlingTree()`, `buildGlobalResultTree()` — two-tier search (LSP references → regex fallback), `classifyLine()` pattern matcher, typed tree structures |

### Commands

| Command ID | Title | Availability |
|---|---|---|
| `errorvis.findResultUsages` | Find Result Usages | Editor context menu (`navigation@5.5`) |
| `errorvis.exportResultTree` | Export Result Tree | Command palette |

### Two-Tier Search Strategy (`resultFinder.ts`)

1. **LSP (rust-analyzer):** Calls `vscode.executeReferenceProvider` to get cross-file references. Accurate but requires rust-analyzer to be active.
2. **Regex fallback:** If LSP returns no results, scans the current document with escaped `symbol` patterns. Single-file only but always available.

### Error-Handling Classification

`classifyLine()` categorises a line containing the symbol into one of 10 handling types:

| Type | Pattern |
|---|---|
| `unwrap` | `.unwrap()` |
| `expect` | `.expect(msg)` |
| `unwrap_or` | `.unwrap_or*()` variants |
| `map_combinator` | `.map()`, `.and_then()`, `.or()`, `.ok()`, `.err()`, `.map_err()`, `.flatten()`, `.transpose()` |
| `question_mark` | `?` operator (propagates) |
| `return` | `return expr` or implicit final expression (propagates) |
| `match` | `match` expressions |
| `if_let` | `if let` patterns |
| `while_let` | `while let` patterns |
| `check` | `.is_ok()` / `.is_err()` |

**Pattern features:**
- Handles dereference operators: `*`, `**`
- Supports method chains with arbitrary call suffixes
- Supports namespace paths: `module::function`, `crate::path::function`
- Supports dot access: `self.field.method()`
- Multi-level nesting in function arguments

### Tree Structures (`resultFinder.ts`)

```typescript
interface HandlingLocation {
  uri: vscode.Uri;
  range: vscode.Range;
  kind: HandlingKind;
  depth: number;
  via?: string;         // propagation origin symbol
}

interface FunctionResultTree {
  symbol: string;
  uri: vscode.Uri;
  locations: HandlingLocation[];
  children: FunctionResultTree[];
}

interface ResultGroup {
  symbol: string;
  uri: vscode.Uri;
  tree: FunctionResultTree;
}

interface GlobalResultTree {
  groups: ResultGroup[];
}
```

### Recursive Tree Traversal (`findHandlingTree`)

- Max recursion depth: `MAX_DEPTH = 10`
- Follows propagating patterns (`question_mark`, `return`) into calling functions
- Cycle detection via `visited` set
- Tracks propagation path with the `via` field

### CodeLens Retry Logic (`codeLensProvider.ts`)

Resolving CodeLens (computing usage counts) uses exponential backoff:
- **36 retries** × 5 s interval ≈ 3 minutes maximum wait
- Three rendering states: unresolved → loading (spinner) → resolved (count badge)
- Results are cached per lens; cache is invalidated on document change

---

## Code Conventions

### Naming

- **Classes:** PascalCase — `ResultCodeLensProvider`
- **Functions:** camelCase — `findHandlingTree`, `showResultPicker`, `buildGlobalResultTree`
- **Constants / regex patterns:** UPPER_SNAKE_CASE — `FN_SIGNATURE`, `RETURNS_RESULT`, `MAX_DEPTH`
- **Private members:** underscore prefix — `_onDidChangeCodeLenses`, `_resolving`

### TypeScript Style

- Strict mode enabled (`"strict": true` in `tsconfig.json`)
- ES6 imports: `import * as vscode from 'vscode'`
- Module system: CommonJS (`"module": "commonjs"`)
- Target: ES2020
- `esModuleInterop: true`, `skipLibCheck: true`, `sourceMap: true`

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

1. Add a new entry to the `HandlingKind` type union in `resultFinder.ts`
2. Add the corresponding regex branch in `classifyLine()`
3. Update `kindLabel()` in `resultFinder.ts` with the new icon/label
4. Add the display icon/label in `extension.ts` (`kindLabelPlain()` or equivalent)
5. Add test cases in `src/test/classifyLine.test.ts`

### Adding a New Language

The extension activates on `onLanguage:rust`. To support another language:

1. Add the language to `activationEvents` in `package.json`
2. Update the document selector in `codeLensProvider.ts` to include the new language
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
- `@types/mocha@^10.0.10`
- `mocha@^11.7.5` — test runner
- `tsx@^4.21.0` — TypeScript ESM/CJS loader for Mocha (via `tsx/cjs`)
- `ts-node@^10.9.2` — TypeScript Node.js runtime

**Recommended for users:** rust-analyzer (enables cross-file LSP references; without it, the regex fallback handles single-file search only).

---

## Git Conventions

- Feature branches merged to `master` via pull requests
- Commit messages are imperative and descriptive (e.g., "Add unit tests for classifyLine patterns")
- The `out/` directory is gitignored — always run `npm run compile` after cloning before debugging

---

## Common Tasks for AI Assistants

- **Adding a new pattern type:** Edit `classifyLine()` and `kindLabel()` in `resultFinder.ts`, update `HandlingKind` union, update display in `extension.ts`, add tests in `src/test/classifyLine.test.ts`.
- **Changing CodeLens appearance:** Edit `ResultCodeLensProvider` in `codeLensProvider.ts`.
- **Modifying the quick-pick UI:** Edit `showResultPicker()` in `extension.ts`.
- **Modifying export output:** Edit `formatJson()` / `formatMarkdown()` in `extension.ts`.
- **Debugging search accuracy:** The two-tier search is in `findHandlingLocations()` in `resultFinder.ts`.
- **Building:** Always run `npm run compile` before testing the extension; it loads from `./out/`, not `./src/`.
- **Running tests:** `npm test` (no VSCode instance needed — uses vscode mock).
- **Adding tests:** Follow the existing pattern in `src/test/classifyLine.test.ts`; place new test files under `src/test/` with a `.test.ts` suffix.
