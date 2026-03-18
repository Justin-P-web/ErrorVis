import * as vscode from 'vscode';
import * as path from 'path';
import { findHandlingTree, kindLabel, HandlingLocation } from './resultFinder';
import { ResultCodeLensProvider } from './codeLensProvider';

let codeLensProvider: ResultCodeLensProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  codeLensProvider = new ResultCodeLensProvider();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: 'rust', scheme: 'file' },
      codeLensProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'errorvis.findResultUsages',
      (uri?: vscode.Uri, position?: vscode.Position) =>
        findResultUsages(uri, position)
    )
  );

  // Refresh lenses when config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('errorvis')) {
        codeLensProvider?.refresh();
      }
    })
  );

  // Invalidate resolved-lens cache when a Rust document is edited
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.languageId === 'rust') {
        codeLensProvider?.refresh();
      }
    })
  );
}

export function deactivate(): void { /* nothing to clean up */ }

async function findResultUsages(
  uri?: vscode.Uri,
  position?: vscode.Position
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('ErrorVis: No active editor.');
    return;
  }

  const document = uri
    ? await vscode.workspace.openTextDocument(uri)
    : editor.document;

  const cursorPosition = position ?? editor.selection.active;

  // Get the symbol name under the cursor
  const wordRange = document.getWordRangeAtPosition(cursorPosition, /[\w]+/);
  if (!wordRange) {
    vscode.window.showWarningMessage('ErrorVis: No symbol found at cursor.');
    return;
  }
  const symbolName = document.getText(wordRange);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `ErrorVis: Searching for "${symbolName}" usages…` },
    async () => {
      const locations = await findHandlingTree(document, symbolName, cursorPosition);

      if (locations.length === 0) {
        vscode.window.showInformationMessage(
          `ErrorVis: No result-handling usages found for "${symbolName}".`
        );
        return;
      }

      await showResultPicker(symbolName, locations, editor);
    }
  );
}

async function showResultPicker(
  symbolName: string,
  locations: HandlingLocation[],
  editor: vscode.TextEditor
): Promise<void> {
  const originalUri = editor.document.uri;
  const originalPosition = editor.selection.active;
  const originalVisible = editor.visibleRanges[0];

  type PickItem = vscode.QuickPickItem & { location: HandlingLocation };

  const items: PickItem[] = locations.map(loc => {
    const relativePath = vscode.workspace.asRelativePath(loc.uri);
    const lineNum = loc.range.start.line + 1;
    const indent = '  '.repeat(loc.depth);
    const viaPrefix = loc.via ? `↳ via ${loc.via}  ` : '';
    return {
      label: `${indent}${kindLabel(loc.kind)}`,
      description: `${viaPrefix}${path.basename(relativePath)}:${lineNum}`,
      detail: `${indent}${loc.lineText}`,
      location: loc,
      alwaysShow: true
    };
  });

  const maxDepth = locations.reduce((m, l) => Math.max(m, l.depth), 0);
  const levelLabel = maxDepth > 0 ? ` across ${maxDepth + 1} level(s)` : '';
  const pick = vscode.window.createQuickPick<PickItem>();
  pick.title = `Result usages of "${symbolName}" — ${locations.length} found${levelLabel}`;
  pick.items = items;
  pick.matchOnDescription = true;
  pick.matchOnDetail = true;

  // Live preview as user moves through items
  pick.onDidChangeActive(async active => {
    if (active.length === 0) { return; }
    const loc = active[0].location;
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: true,
      selection: loc.range
    });
  });

  pick.onDidAccept(async () => {
    const selected = pick.selectedItems[0];
    pick.hide();
    if (!selected) { return; }
    const loc = selected.location;
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    await vscode.window.showTextDocument(doc, {
      preview: false,
      selection: loc.range
    });
  });

  // Restore original position if user cancels
  pick.onDidHide(async () => {
    pick.dispose();
    if (pick.selectedItems.length === 0) {
      const originalDoc = await vscode.workspace.openTextDocument(originalUri);
      const restored = await vscode.window.showTextDocument(originalDoc, {
        preview: false,
        selection: new vscode.Selection(originalPosition, originalPosition)
      });
      restored.revealRange(originalVisible, vscode.TextEditorRevealType.AtTop);
    }
  });

  pick.show();
}
