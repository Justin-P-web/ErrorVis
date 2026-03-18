import * as vscode from 'vscode';
import { findHandlingLocations } from './resultFinder';

// Matches `fn name(` and captures the function name; line must also contain `-> Result<` or `-> Option<`
const FN_SIGNATURE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*[<(]/;
const RETURNS_RESULT = /->.*?(?:Result|Option)\s*</;

interface LensData {
  fnName: string;
  position: vscode.Position;
}

export class ResultCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  refresh(): void {
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

      lenses.push(new vscode.CodeLens(range, {
        title: '$(loading~spin) Loading result usages…',
        command: '',
        arguments: [{ fnName, position } as LensData]
      }));
    }

    return lenses;
  }

  async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return lens; }

    const data = lens.command?.arguments?.[0] as LensData | undefined;
    if (!data) { return lens; }

    const { fnName, position } = data;
    const document = editor.document;

    const locations = await findHandlingLocations(document, fnName, position);
    const count = locations.length;

    lens.command = {
      title: count === 0
        ? '$(circle-slash) No result usages found'
        : `$(references) ${count} result ${count === 1 ? 'usage' : 'usages'} handled`,
      command: count > 0 ? 'errorvis.findResultUsages' : '',
      arguments: [document.uri, position]
    };

    return lens;
  }
}
