import * as vscode from 'vscode';
import { findHandlingLocations } from './resultFinder';

// setTimeout is available in the VS Code extension host (Node.js) but not declared
// in lib: ["ES2020"] without @types/node; this declaration avoids a compile error.
declare function setTimeout(callback: () => void, ms: number): unknown;

const MAX_RETRY_COUNT = 6;   // give up after ~30 s (6 × 5 s)
const RETRY_DELAY_MS  = 5000;

// Matches `fn name(` and captures the function name; line must also contain `-> Result<` or `-> Option<`
const FN_SIGNATURE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*[<(]/;
const RETURNS_RESULT = /->.*?(?:Result|Option)\s*</;

interface LensData {
  document: vscode.TextDocument;
  fnName: string;
  position: vscode.Position;
  key: string;
}

export class ResultCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  // key = `${fnName}:${position.line}`
  private _stepMessages  = new Map<string, string>();         // key → current step title
  private _resolving     = new Set<string>();                 // keys currently being resolved
  private _resolvedCmds  = new Map<string, vscode.Command>(); // key → final command (cache)
  private _pendingData   = new Map<number, LensData>();       // line → data for resolveCodeLens
  private _retryCount    = new Map<string, number>();         // key → retries used so far

  refresh(): void {
    this._resolvedCmds.clear();
    this._stepMessages.clear();
    this._resolving.clear();
    this._pendingData.clear();
    this._retryCount.clear();
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const config = vscode.workspace.getConfiguration('errorvis');
    if (!config.get<boolean>('enableCodeLens', true)) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const fnMatch = FN_SIGNATURE.exec(line.text);
      if (!fnMatch) { continue; }

      // Collect lines of the signature (may span multiple lines until `{` or `;`)
      let sigText = line.text;
      let j = i + 1;
      while (j < document.lineCount && !sigText.includes('{') && !sigText.includes(';') && j - i < 10) {
        sigText += ' ' + document.lineAt(j).text;
        j++;
      }

      if (!RETURNS_RESULT.test(sigText)) { continue; }

      const fnName = fnMatch[1];
      const col = line.text.indexOf(fnName);
      const position = new vscode.Position(i, col);
      const range = new vscode.Range(position, position);
      const key = `${fnName}:${i}`;

      if (this._resolvedCmds.has(key)) {
        // Pre-resolved: VS Code won't call resolveCodeLens
        lenses.push(new vscode.CodeLens(range, this._resolvedCmds.get(key)!));
      } else if (this._resolving.has(key)) {
        // Resolution in progress: show loading title with a command so VS Code
        // doesn't call resolveCodeLens again (it's already running)
        const title = this._stepMessages.get(key)
          ?? `$(loading~spin) Querying LSP for "${fnName}"…`;
        lenses.push(new vscode.CodeLens(range, { title, command: '' }));
      } else {
        // Not yet started: store data for resolveCodeLens and return a lens
        // WITHOUT a command so VS Code will call resolveCodeLens
        this._pendingData.set(i, { document, fnName, position, key });
        lenses.push(new vscode.CodeLens(range));
      }
    }

    return lenses;
  }

  async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
    const line = lens.range.start.line;
    const data = this._pendingData.get(line);
    if (!data) { return lens; }

    const { document, fnName, position, key } = data;

    // Mid-resolution re-entry: return with current step title as-is
    if (this._resolving.has(key)) { return lens; }

    this._resolving.add(key);

    const onProgress = (step: string) => {
      this._stepMessages.set(key, step);
      this._onDidChangeCodeLenses.fire();
    };

    const { locations, lspAvailable } = await findHandlingLocations(document, fnName, position, onProgress);
    const count = locations.length;

    const retries = this._retryCount.get(key) ?? 0;
    if (count === 0 && retries < MAX_RETRY_COUNT) {
      // rust-analyzer hasn't finished loading/indexing yet — show a transient placeholder and schedule a retry
      const waitingTitle = lspAvailable
        ? '$(sync~spin) Waiting for rust-analyzer to index…'
        : '$(sync~spin) Waiting for rust-analyzer…';
      const waitingCommand: vscode.Command = {
        title: waitingTitle,
        command: ''
      };
      this._resolvedCmds.set(key, waitingCommand);
      this._resolving.delete(key);
      this._stepMessages.delete(key);
      this._pendingData.delete(line);
      this._retryCount.set(key, retries + 1);
      this._onDidChangeCodeLenses.fire();

      setTimeout(() => {
        // Remove the placeholder so provideCodeLenses creates a fresh unresolved lens
        this._resolvedCmds.delete(key);
        this._onDidChangeCodeLenses.fire();
      }, RETRY_DELAY_MS);

      lens.command = waitingCommand;
      return lens;
    }

    // LSP responded (or we've exhausted retries) — cache the final result
    this._retryCount.delete(key);

    const command: vscode.Command = {
      title: count === 0
        ? '$(circle-slash) No result usages found'
        : `$(references) ${count} result ${count === 1 ? 'usage' : 'usages'} handled`,
      command: count > 0 ? 'errorvis.findResultUsages' : '',
      arguments: [document.uri, position]
    };

    this._resolvedCmds.set(key, command);
    this._resolving.delete(key);
    this._stepMessages.delete(key);
    this._pendingData.delete(line);
    this._onDidChangeCodeLenses.fire(); // show final result via cache

    lens.command = command;
    return lens;
  }
}
