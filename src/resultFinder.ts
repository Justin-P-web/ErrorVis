import * as vscode from 'vscode';

export interface HandlingLocation {
  uri: vscode.Uri;
  range: vscode.Range;
  lineText: string;
  kind: HandlingKind;
}

export type HandlingKind =
  | 'unwrap'
  | 'expect'
  | 'unwrap_or'
  | 'map_combinator'
  | 'question_mark'
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
const MATCH_PATTERN = /\bmatch\s+\*{0,2}\s*(SYMBOL)\b/;
const IF_LET_PATTERN = /\bif\s+let\s+(?:Ok|Err|Some|None)\s*(?:\([^)]*\))?\s*=\s*\*{0,2}\s*(SYMBOL)\b/;
const WHILE_LET_PATTERN = /\bwhile\s+let\s+(?:Ok|Err|Some|None)\s*(?:\([^)]*\))?\s*=\s*\*{0,2}\s*(SYMBOL)\b/;

function buildPattern(template: RegExp, symbol: string): RegExp {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(template.source.replace('SYMBOL', escaped), template.flags);
}

function classifyLine(lineText: string, symbol: string): HandlingKind | null {
  if (buildPattern(QUESTION_MARK_PATTERN, symbol).test(lineText)) {
    return 'question_mark';
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
export async function findHandlingLocations(
  document: vscode.TextDocument,
  symbolName: string,
  position: vscode.Position,
  onProgress?: (step: string) => void
): Promise<HandlingLocation[]> {
  const results: HandlingLocation[] = [];

  // --- Tier 1: LSP references ---
  onProgress?.(`$(loading~spin) Querying LSP for "${symbolName}"…`);
  let locations: vscode.Location[] | undefined;
  try {
    const raw = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      document.uri,
      position
    );
    if (raw && raw.length > 0) {
      locations = raw;
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
      return results;
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
    case 'match': return '$(symbol-enum) match';
    case 'if_let': return '$(symbol-keyword) if let';
    case 'while_let': return '$(symbol-keyword) while let';
    case 'check': return '$(symbol-boolean) .is_ok()/.is_err()';
  }
}
