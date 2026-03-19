import * as vscode from 'vscode';

export interface HandlingLocation {
  uri: vscode.Uri;
  range: vscode.Range;
  lineText: string;
  kind: HandlingKind;
  depth: number;   // 0 = direct caller, 1 = caller's caller, etc.
  via?: string;    // function name through which propagation occurred
}

export type HandlingKind =
  | 'unwrap'
  | 'expect'
  | 'unwrap_or'
  | 'map_combinator'
  | 'question_mark'
  | 'return'
  | 'match'
  | 'if_let'
  | 'while_let'
  | 'check';

export interface FunctionResultTree {
  fnName: string;
  filePath: string;  // workspace-relative path
  line: number;      // 1-based line of fn definition
  handling: HandlingLocation[];
}

export interface ResultGroup {
  kind: 'struct' | 'file';
  label: string;    // struct name OR relative file path
  filePath: string; // always the relative file path (for context in struct groups)
  functions: FunctionResultTree[];
}

export interface GlobalResultTree {
  generatedAt: string; // ISO timestamp
  groups: ResultGroup[];
}

// Optional function-call suffix, handling one level of argument nesting: foo(a, bar(b))
const CALL_SUFFIX = '(?:\\([^()]*(?:\\([^()]*\\)[^()]*)*\\))?';

// All Result/Option method chain handlers
const METHOD_CHAIN_PATTERN = new RegExp(
  `\\b(SYMBOL)${CALL_SUFFIX}\\s*\\.\\s*(unwrap|expect|unwrap_or(?:_else|_default)?|map|and_then|or(?:_else)?|is_ok|is_err|ok|err|map_err|flatten|transpose)\\s*[(\\s;,)]`
);
const QUESTION_MARK_PATTERN = new RegExp(`\\b(SYMBOL)${CALL_SUFFIX}\\s*\\?`);
// Optional path prefix: handles both dot-notation (obj.field.) and namespace paths (module::sub::)
const PATH_PREFIX = '(?:(?:\\w+)(?:::|\\.))+';
const RETURN_PATTERN = new RegExp(`\\breturn\\s+(?:${PATH_PREFIX})?\\*{0,2}\\s*(SYMBOL)${CALL_SUFFIX}\\s*;?`);
const DIRECT_RETURN_PATTERN = new RegExp(`^\\s*(?:${PATH_PREFIX})?\\*{0,2}\\s*(SYMBOL)${CALL_SUFFIX}\\s*$`);
const MATCH_PATTERN = new RegExp(`\\bmatch\\s+(?:${PATH_PREFIX})?\\*{0,2}\\s*(SYMBOL)\\b${CALL_SUFFIX}`);
const IF_LET_PATTERN = new RegExp(`\\bif\\s+let\\s+(?:Ok|Err|Some|None)\\s*(?:\\([^)]*\\))?\\s*=\\s*(?:${PATH_PREFIX})?\\*{0,2}\\s*(SYMBOL)\\b${CALL_SUFFIX}`);
const WHILE_LET_PATTERN = new RegExp(`\\bwhile\\s+let\\s+(?:Ok|Err|Some|None)\\s*(?:\\([^)]*\\))?\\s*=\\s*(?:${PATH_PREFIX})?\\*{0,2}\\s*(SYMBOL)\\b${CALL_SUFFIX}`);

const MAX_DEPTH = 10;

// Mirror of constants in codeLensProvider.ts — duplicated here to avoid a circular import.
const FN_SIGNATURE  = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*[<(]/;
const RETURNS_RESULT = /->.*?(?:Result|Option)\s*</;
const IMPL_LINE = /^\s*impl\b/;

function buildPattern(template: RegExp, symbol: string): RegExp {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(template.source.replace('SYMBOL', escaped), template.flags);
}

export function classifyLine(lineText: string, symbol: string): HandlingKind | null {
  if (buildPattern(QUESTION_MARK_PATTERN, symbol).test(lineText)) {
    return 'question_mark';
  }
  if (buildPattern(RETURN_PATTERN, symbol).test(lineText)) {
    return 'return';
  }
  if (buildPattern(DIRECT_RETURN_PATTERN, symbol).test(lineText)) {
    return 'return';
  }
  if (buildPattern(MATCH_PATTERN, symbol).test(lineText)) {
    return 'match';
  }
  if (buildPattern(IF_LET_PATTERN, symbol).test(lineText)) {
    return 'if_let';
  }
  if (buildPattern(WHILE_LET_PATTERN, symbol).test(lineText)) {
    return 'while_let';
  }

  const chainMatch = buildPattern(METHOD_CHAIN_PATTERN, symbol).exec(lineText);
  if (chainMatch) {
    const method = chainMatch[2];
    if (method === 'unwrap') { return 'unwrap'; }
    if (method === 'expect') { return 'expect'; }
    if (method.startsWith('unwrap_or')) { return 'unwrap_or'; }
    if (method === 'is_ok' || method === 'is_err') { return 'check'; }
    return 'map_combinator';
  }

  return null;
}

/**
 * Finds all locations in the document where `symbolName` is handled as a Result/Option.
 *
 * Strategy:
 *  1. Ask the LSP for all references (works if rust-analyzer is active).
 *  2. Fall back to a regex scan of the whole document when LSP returns nothing.
 *
 * In both cases we filter the candidate lines through `classifyLine`.
 */
export type FindHandlingResult = {
  locations: Array<{ uri: vscode.Uri; range: vscode.Range; lineText: string; kind: HandlingKind }>;
  /** True when the LSP responded (rust-analyzer is active), false when unavailable or errored. */
  lspAvailable: boolean;
};

export async function findHandlingLocations(
  document: vscode.TextDocument,
  symbolName: string,
  position: vscode.Position,
  onProgress?: (step: string) => void
): Promise<FindHandlingResult> {
  const results: Array<{ uri: vscode.Uri; range: vscode.Range; lineText: string; kind: HandlingKind }> = [];
  let lspAvailable = false;

  // --- Tier 1: LSP references ---
  onProgress?.(`$(loading~spin) Querying LSP for "${symbolName}"…`);
  let locations: vscode.Location[] | undefined;
  try {
    const raw = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      document.uri,
      position
    );
    if (raw !== null && raw !== undefined) {
      lspAvailable = true; // rust-analyzer responded (even if it returned 0 references)
      if (raw.length > 0) {
        locations = raw;
      }
    }
  } catch {
    // LSP not available — fall through to tier 2
  }

  if (locations && locations.length > 0) {
    for (const loc of locations) {
      const doc = loc.uri.toString() === document.uri.toString()
        ? document
        : await tryOpenDocument(loc.uri);
      if (!doc) { continue; }

      const lineText = doc.lineAt(loc.range.start.line).text;
      const kind = classifyLine(lineText, symbolName);
      if (kind !== null) {
        results.push({ uri: loc.uri, range: loc.range, lineText: lineText.trim(), kind });
      }
    }
    if (results.length > 0) {
      return { locations: results, lspAvailable };
    }
  }

  // --- Tier 2: regex scan of the current document ---
  onProgress?.(`$(loading~spin) Scanning document for "${symbolName}"…`);
  const text = document.getText();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const kind = classifyLine(lineText, symbolName);
    if (kind !== null) {
      // Locate the symbol on this line for precise range
      const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const symIdx = lineText.search(new RegExp(`\\b${escaped}\\b`));
      const col = symIdx >= 0 ? symIdx : 0;
      const range = new vscode.Range(i, col, i, col + symbolName.length);
      results.push({ uri: document.uri, range, lineText: lineText.trim(), kind });
    }
  }

  return { locations: results, lspAvailable };
}

/**
 * Finds the name and definition position of the innermost function containing `position`.
 *
 * Strategy:
 *  1. Ask the LSP for document symbols.
 *  2. Fall back to scanning lines upward for a `fn name` declaration.
 */
async function getEnclosingFunctionName(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<{ name: string; uri: vscode.Uri; position: vscode.Position } | undefined> {
  // --- Tier 1: LSP document symbols ---
  try {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );
    if (symbols && symbols.length > 0) {
      const found = findInnermostFunction(symbols, position);
      if (found) {
        return {
          name: found.name,
          uri: document.uri,
          position: found.selectionRange.start
        };
      }
    }
  } catch {
    // LSP not available — fall through
  }

  // --- Tier 2: regex scan upward ---
  const fnPattern = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/;
  for (let i = position.line; i >= 0; i--) {
    const lineText = document.lineAt(i).text;
    const match = fnPattern.exec(lineText);
    if (match) {
      const col = lineText.indexOf(match[1]);
      return {
        name: match[1],
        uri: document.uri,
        position: new vscode.Position(i, col >= 0 ? col : 0)
      };
    }
  }

  return undefined;
}

function findInnermostFunction(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position
): vscode.DocumentSymbol | undefined {
  let best: vscode.DocumentSymbol | undefined;
  for (const sym of symbols) {
    if (!sym.range.contains(position)) { continue; }
    if (sym.kind === vscode.SymbolKind.Function || sym.kind === vscode.SymbolKind.Method) {
      // Prefer the innermost (smallest range) enclosing function
      if (!best || rangeSize(sym.range) < rangeSize(best.range)) {
        best = sym;
      }
    }
    // Recurse into children
    if (sym.children && sym.children.length > 0) {
      const child = findInnermostFunction(sym.children, position);
      if (child && (!best || rangeSize(child.range) < rangeSize(best.range))) {
        best = child;
      }
    }
  }
  return best;
}

function rangeSize(range: vscode.Range): number {
  return (range.end.line - range.start.line) * 10000 + range.end.character;
}

/**
 * Finds the definition location of a named function in the workspace.
 *
 * Strategy:
 *  1. Workspace symbol provider.
 *  2. Scan `fallbackDocument` for `fn name`.
 */
async function findFunctionDefinition(
  fnName: string,
  fallbackDocument: vscode.TextDocument
): Promise<{ uri: vscode.Uri; position: vscode.Position } | undefined> {
  // --- Tier 1: workspace symbols ---
  try {
    const wsSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      fnName
    );
    if (wsSymbols && wsSymbols.length > 0) {
      const match = wsSymbols.find(
        s =>
          s.name === fnName &&
          (s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Method)
      );
      if (match) {
        return { uri: match.location.uri, position: match.location.range.start };
      }
    }
  } catch {
    // fall through
  }

  // --- Tier 2: scan the fallback document ---
  const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fnPattern = new RegExp(`\\bfn\\s+${escaped}\\b`);
  const lines = fallbackDocument.getText().split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = fnPattern.exec(lines[i]);
    if (m) {
      const col = lines[i].indexOf(fnName);
      return {
        uri: fallbackDocument.uri,
        position: new vscode.Position(i, col >= 0 ? col : 0)
      };
    }
  }

  return undefined;
}

/**
 * Recursively finds all handling locations for `symbolName`, following the error
 * propagation tree upward when a usage is `?` or an explicit `return`.
 *
 * @param visited  Set of function names already visited (cycle guard).
 * @param depth    Current recursion depth (starts at 0).
 */
export async function findHandlingTree(
  document: vscode.TextDocument,
  symbolName: string,
  position: vscode.Position,
  onProgress?: (step: string) => void,
  visited: Set<string> = new Set(),
  depth: number = 0
): Promise<HandlingLocation[]> {
  if (visited.has(symbolName) || depth > MAX_DEPTH) {
    return [];
  }
  visited.add(symbolName);

  const { locations: raw } = await findHandlingLocations(document, symbolName, position, onProgress);
  const results: HandlingLocation[] = raw.map(r => ({ ...r, depth, via: depth > 0 ? symbolName : undefined }));

  // For each propagating usage, continue up the tree
  for (const loc of raw) {
    if (loc.kind !== 'question_mark' && loc.kind !== 'return') { continue; }

    const usageDoc = loc.uri.toString() === document.uri.toString()
      ? document
      : await tryOpenDocument(loc.uri);
    if (!usageDoc) { continue; }

    const enclosing = await getEnclosingFunctionName(usageDoc, loc.range.start);
    if (!enclosing || visited.has(enclosing.name)) { continue; }

    const defDoc = enclosing.uri.toString() === document.uri.toString()
      ? document
      : await tryOpenDocument(enclosing.uri);

    const def = await findFunctionDefinition(enclosing.name, defDoc ?? usageDoc);
    if (!def) { continue; }

    const defDocument = def.uri.toString() === document.uri.toString()
      ? document
      : await tryOpenDocument(def.uri);
    if (!defDocument) { continue; }

    onProgress?.(`$(loading~spin) Following propagation through "${enclosing.name}"…`);
    const subResults = await findHandlingTree(
      defDocument,
      enclosing.name,
      def.position,
      onProgress,
      visited,
      depth + 1
    );
    results.push(...subResults);
  }

  return results;
}

/** Strips nested angle-bracket generics from a line to simplify impl-struct extraction. */
function stripGenerics(line: string): string {
  let s = line;
  for (let i = 0; i < 6; i++) {
    const stripped = s.replace(/<[^<>]*>/g, '');
    if (stripped === s) { break; }
    s = stripped;
  }
  return s;
}

/** Extracts the concrete struct/type name from an `impl ...` line. */
function extractImplStructName(line: string): string | null {
  const simplified = stripGenerics(line);
  // Prefer "for TypeName" (trait impl) over the first type after `impl`
  const forMatch = /\bfor\s+(\w+)/.exec(simplified);
  if (forMatch) { return forMatch[1]; }
  const implMatch = /\bimpl\s+(\w+)/.exec(simplified);
  return implMatch ? implMatch[1] : null;
}

interface ScannedFn {
  fnName: string;
  position: vscode.Position;
  implName: string | null;
}

/** Scans a document and returns all Result/Option-returning functions with their impl context. */
function scanDocumentForResultFns(document: vscode.TextDocument): ScannedFn[] {
  const results: ScannedFn[] = [];
  let braceDepth = 0;
  let currentImpl: string | null = null;
  let implBraceDepth = 0;

  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;

    // Detect impl block that opens on this line
    if (currentImpl === null && IMPL_LINE.test(text) && text.includes('{')) {
      const name = extractImplStructName(text);
      if (name) {
        currentImpl = name;
        implBraceDepth = braceDepth; // depth BEFORE this line's braces
      }
    }

    // Count braces on this line
    for (const ch of text) {
      if (ch === '{') { braceDepth++; }
      else if (ch === '}') { braceDepth--; }
    }

    // Check if we've exited the impl block
    if (currentImpl !== null && braceDepth <= implBraceDepth) {
      currentImpl = null;
    }

    // Check for a Result/Option-returning fn
    const fnMatch = FN_SIGNATURE.exec(text);
    if (!fnMatch) { continue; }

    // Collect multi-line signature (same logic as codeLensProvider)
    let sigText = text;
    let j = i + 1;
    while (j < document.lineCount && !sigText.includes('{') && !sigText.includes(';') && j - i < 10) {
      sigText += ' ' + document.lineAt(j).text;
      j++;
    }
    if (!RETURNS_RESULT.test(sigText)) { continue; }

    const fnName = fnMatch[1];
    const col = text.indexOf(fnName);
    results.push({
      fnName,
      position: new vscode.Position(i, col >= 0 ? col : 0),
      implName: currentImpl
    });
  }

  return results;
}

/**
 * Scans every Rust file in the workspace, builds a handling tree for each
 * Result/Option-returning function, and returns results grouped by struct (for
 * impl methods) or by file (for free functions).
 */
export async function buildGlobalResultTree(
  onProgress?: (message: string, increment: number) => void
): Promise<GlobalResultTree> {
  const uris = await vscode.workspace.findFiles('**/*.rs', '**/target/**');

  // Phase 1: collect all Result/Option-returning functions across the workspace
  interface PendingFn extends ScannedFn {
    uri: vscode.Uri;
    filePath: string;
  }
  const pending: PendingFn[] = [];
  for (const uri of uris) {
    const doc = await tryOpenDocument(uri);
    if (!doc) { continue; }
    const filePath = vscode.workspace.asRelativePath(uri);
    for (const fn of scanDocumentForResultFns(doc)) {
      pending.push({ uri, filePath, ...fn });
    }
  }

  if (pending.length === 0) {
    return { generatedAt: new Date().toISOString(), groups: [] };
  }

  const increment = 100 / pending.length;

  // Phase 2: build handling tree for each function, grouped by struct or file
  const groupMap = new Map<string, ResultGroup>();

  for (const fn of pending) {
    onProgress?.(`$(loading~spin) Analysing "${fn.fnName}" in ${fn.filePath}…`, increment);

    const doc = await tryOpenDocument(fn.uri);
    if (!doc) { continue; }

    const handling = await findHandlingTree(doc, fn.fnName, fn.position);
    if (handling.length === 0) { continue; }

    const groupKey = fn.implName
      ? `struct:${fn.implName}:${fn.filePath}`
      : `file:${fn.filePath}`;

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        kind: fn.implName ? 'struct' : 'file',
        label: fn.implName ?? fn.filePath,
        filePath: fn.filePath,
        functions: []
      });
    }

    groupMap.get(groupKey)!.functions.push({
      fnName: fn.fnName,
      filePath: fn.filePath,
      line: fn.position.line + 1,
      handling
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    groups: Array.from(groupMap.values())
  };
}

async function tryOpenDocument(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}

export function kindLabel(kind: HandlingKind): string {
  switch (kind) {
    case 'unwrap': return '$(error) .unwrap()';
    case 'expect': return '$(warning) .expect(...)';
    case 'unwrap_or': return '$(symbol-method) .unwrap_or*(...)';
    case 'map_combinator': return '$(symbol-method) combinator';
    case 'question_mark': return '$(symbol-operator) ?';
    case 'return': return '$(arrow-right) return';
    case 'match': return '$(symbol-enum) match';
    case 'if_let': return '$(symbol-keyword) if let';
    case 'while_let': return '$(symbol-keyword) while let';
    case 'check': return '$(symbol-boolean) .is_ok()/.is_err()';
  }
}
