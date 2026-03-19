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

// Optional function-call suffix, handling one level of argument nesting: foo(a, bar(b))
const CALL_SUFFIX = '(?:\\([^()]*(?:\\([^()]*\\)[^()]*)*\\))?';

// All Result/Option method chain handlers
const METHOD_CHAIN_PATTERN = new RegExp(
  `\\b(SYMBOL)${CALL_SUFFIX}\\s*\\.\\s*(unwrap|expect|unwrap_or(?:_else|_default)?|map|and_then|or(?:_else)?|is_ok|is_err|ok|err|map_err|flatten|transpose)\\s*[(\\s;,)]`
);
const QUESTION_MARK_PATTERN = new RegExp(`\\b(SYMBOL)${CALL_SUFFIX}\\s*\\?`);
const RETURN_PATTERN = new RegExp(`\\breturn\\s+(?:\\w+(?:\\.\\w+)*\\.)?\\*{0,2}\\s*(SYMBOL)${CALL_SUFFIX}\\s*;?`);
const DIRECT_RETURN_PATTERN = new RegExp(`^\\s*(?:\\w+(?:\\.\\w+)*\\.)?\\*{0,2}\\s*(SYMBOL)${CALL_SUFFIX}\\s*$`);
const MATCH_PATTERN = /\bmatch\s+\*{0,2}\s*(SYMBOL)\b/;
const IF_LET_PATTERN = /\bif\s+let\s+(?:Ok|Err|Some|None)\s*(?:\([^)]*\))?\s*=\s*\*{0,2}\s*(SYMBOL)\b/;
const WHILE_LET_PATTERN = /\bwhile\s+let\s+(?:Ok|Err|Some|None)\s*(?:\([^)]*\))?\s*=\s*\*{0,2}\s*(SYMBOL)\b/;

const MAX_DEPTH = 10;

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
