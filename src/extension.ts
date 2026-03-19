import * as vscode from 'vscode';
import * as path from 'path';
import { findHandlingTree, kindLabel, HandlingLocation, buildGlobalResultTree, GlobalResultTree, HandlingKind } from './resultFinder';
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

  context.subscriptions.push(
    vscode.commands.registerCommand('errorvis.exportResultTree', exportResultTree)
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

async function exportResultTree(): Promise<void> {
  const defaultFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(defaultFolder, 'result-tree.json')),
    filters: { 'JSON files': ['json'] },
    saveLabel: 'Export'
  });
  if (!saveUri) { return; }

  const jsonPath = saveUri.fsPath;
  const mdPath = jsonPath.replace(/\.json$/i, '') + '.md';
  const mmdPath = jsonPath.replace(/\.json$/i, '') + '.mmd';
  const mdUri = vscode.Uri.file(mdPath);
  const mmdUri = vscode.Uri.file(mmdPath);

  let tree: GlobalResultTree | undefined;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ErrorVis: Building result tree…', cancellable: false },
    async progress => {
      tree = await buildGlobalResultTree((message, increment) => {
        progress.report({ message, increment });
      });
    }
  );

  if (!tree || tree.groups.length === 0) {
    vscode.window.showInformationMessage('ErrorVis: No result-handling usages found in workspace.');
    return;
  }

  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(saveUri, encoder.encode(formatJson(tree)));
  await vscode.workspace.fs.writeFile(mdUri, encoder.encode(formatMarkdown(tree)));
  await vscode.workspace.fs.writeFile(mmdUri, encoder.encode(formatMermaid(tree)));

  const totalFns = tree.groups.reduce((n, g) => n + g.functions.length, 0);
  const action = await vscode.window.showInformationMessage(
    `ErrorVis: Result tree exported — ${totalFns} function(s) across ${tree.groups.length} group(s).`,
    'Open Mermaid',
    'Open Markdown',
    'Open JSON'
  );
  if (action === 'Open Mermaid') {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mmdUri));
  } else if (action === 'Open Markdown') {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mdUri));
  } else if (action === 'Open JSON') {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(saveUri));
  }
}

export interface CallSiteEntry { fnLabel: string; kind: HandlingKind; via?: string }
export interface CallSite { filePath: string; line: number; lineText: string; entries: CallSiteEntry[] }

export function buildCallSiteIndex(tree: GlobalResultTree): Map<string, CallSite> {
  const map = new Map<string, CallSite>();
  for (const group of tree.groups) {
    for (const fn of group.functions) {
      const fnLabel = group.kind === 'struct' ? `${group.label}::${fn.fnName}` : fn.fnName;
      for (const h of fn.handling) {
        const relPath = vscode.workspace.asRelativePath(h.uri);
        const line = h.range.start.line + 1;
        const key = `${relPath}:${line}`;
        if (!map.has(key)) {
          map.set(key, { filePath: relPath, line, lineText: h.lineText, entries: [] });
        }
        map.get(key)!.entries.push({ fnLabel, kind: h.kind, via: h.via });
      }
    }
  }
  return map;
}

export function kindLabelPlain(kind: HandlingKind): string {
  switch (kind) {
    case 'unwrap':          return '.unwrap()';
    case 'expect':          return '.expect(...)';
    case 'unwrap_or':       return '.unwrap_or*(...)';
    case 'map_combinator':  return 'combinator';
    case 'question_mark':   return '?';
    case 'return':          return 'return';
    case 'match':           return 'match';
    case 'if_let':          return 'if let';
    case 'while_let':       return 'while let';
    case 'check':           return '.is_ok()/.is_err()';
  }
}

export function formatJson(tree: GlobalResultTree): string {
  const callSiteIndex = buildCallSiteIndex(tree);
  const callSites = [...callSiteIndex.values()]
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line)
    .map(site => ({
      filePath: site.filePath,
      line: site.line,
      lineText: site.lineText,
      handlers: site.entries.map(e => ({
        kind: e.kind,
        via: e.via ?? null,
        function: e.fnLabel
      }))
    }));

  return JSON.stringify({
    generatedAt: tree.generatedAt,
    groups: tree.groups.map(g => ({
      kind: g.kind,
      label: g.label,
      filePath: g.filePath,
      functions: g.functions.map(f => ({
        fnName: f.fnName,
        filePath: f.filePath,
        line: f.line,
        handling: f.handling.map(h => ({
          kind: h.kind,
          depth: h.depth,
          via: h.via ?? null,
          filePath: vscode.workspace.asRelativePath(h.uri),
          line: h.range.start.line + 1,
          lineText: h.lineText
        }))
      }))
    })),
    callSites
  }, null, 2);
}

export function formatMermaid(tree: GlobalResultTree): string {
  const safeId = (name: string) =>
    'fn_' + name.replace(/[^a-zA-Z0-9]/g, '_');

  // Collect all source function names (Result/Option-returning fns in the tree)
  const sourceFns = new Set<string>();
  for (const group of tree.groups) {
    for (const fn of group.functions) {
      sourceFns.add(fn.fnName);
    }
  }

  // Collect pass-through functions: appear in loc.via but are not themselves sources
  const passthroughFns = new Set<string>();
  for (const group of tree.groups) {
    for (const fn of group.functions) {
      for (const loc of fn.handling) {
        if (loc.via && !sourceFns.has(loc.via)) {
          passthroughFns.add(loc.via);
        }
      }
    }
  }

  // Build edge map: (fromId, toId) → { label, count }
  const edgeMap = new Map<string, { fromId: string; toId: string; label: string; count: number }>();
  const addEdge = (fromId: string, toId: string, label: string) => {
    const key = `${fromId}→${toId}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      edgeMap.set(key, { fromId, toId, label, count: 1 });
    }
  };

  // Collect which terminal handler kinds are actually used
  const usedKinds = new Set<HandlingKind>();

  for (const group of tree.groups) {
    for (const fn of group.functions) {
      const srcId = safeId(fn.fnName);
      for (const loc of fn.handling) {
        if (loc.via) {
          // source → pass-through (propagation edge)
          const viaId = safeId(loc.via);
          addEdge(srcId, viaId, '?');
          // pass-through → terminal handler
          addEdge(viaId, `h_${loc.kind}`, kindLabelPlain(loc.kind));
        } else {
          // source → terminal handler (direct)
          addEdge(srcId, `h_${loc.kind}`, kindLabelPlain(loc.kind));
        }
        usedKinds.add(loc.kind);
      }
    }
  }

  // Build subgraph map for groups with ≥2 functions
  const subgraphMap = new Map<string, { sgId: string; label: string; fnNames: string[] }>();
  const subgraphedFns = new Set<string>();
  for (const group of tree.groups) {
    if (group.functions.length >= 2) {
      const sgId = 'sg_' + (group.kind === 'struct' ? group.label : group.filePath)
        .replace(/[^a-zA-Z0-9]/g, '_');
      const sgLabel = group.kind === 'struct'
        ? `${group.label} — ${group.filePath}`
        : group.filePath;
      subgraphMap.set(sgId, { sgId, label: sgLabel, fnNames: group.functions.map(f => f.fnName) });
      for (const f of group.functions) { subgraphedFns.add(f.fnName); }
    }
  }

  const lines: string[] = [
    '%%{init: {"theme":"neutral"}}%%',
    'graph TD',
    '  classDef source fill:#4A90D9,stroke:#2C5F8A,color:#fff',
    '  classDef passthrough fill:#F5A623,stroke:#C67D0E,color:#333,stroke-dasharray:5 5',
    '  classDef danger fill:#C0392B,stroke:#922B21,color:#fff',
    '  classDef safe fill:#27AE60,stroke:#1E8449,color:#fff',
    '  classDef combinator fill:#2980B9,stroke:#1A5276,color:#fff',
    '  classDef check fill:#7F8C8D,stroke:#566573,color:#fff',
    '  classDef propagate fill:#8E44AD,stroke:#6C3483,color:#fff',
    '',
    '  %% Source functions (return Result/Option)',
  ];

  // Emit subgraphs for grouped structs/files
  for (const { sgId, label, fnNames } of subgraphMap.values()) {
    lines.push(`  subgraph ${sgId} ["${label}"]`);
    for (const fn of fnNames) {
      lines.push(`    ${safeId(fn)}["${fn}"]:::source`);
    }
    lines.push('  end');
  }
  // Emit ungrouped source functions (single-fn groups)
  for (const fn of sourceFns) {
    if (!subgraphedFns.has(fn)) {
      lines.push(`  ${safeId(fn)}["${fn}"]:::source`);
    }
  }

  if (passthroughFns.size > 0) {
    lines.push('');
    lines.push('  %% Pass-through functions (propagate without handling)');
    for (const fn of passthroughFns) {
      lines.push(`  ${safeId(fn)}(["${fn}"]):::passthrough`);
    }
  }

  // Terminal handler node definitions
  // Shape and class per kind
  const kindDef: Record<HandlingKind, { shape: [string, string]; cls: string }> = {
    unwrap:         { shape: ['{{', '}}'], cls: 'danger' },
    expect:         { shape: ['{{', '}}'], cls: 'danger' },
    unwrap_or:      { shape: ['{', '}'],   cls: 'safe' },
    map_combinator: { shape: ['[/', '/]'], cls: 'combinator' },
    question_mark:  { shape: ['([', '])'], cls: 'propagate' },
    return:         { shape: ['([', '])'], cls: 'propagate' },
    match:          { shape: ['{', '}'],   cls: 'safe' },
    if_let:         { shape: ['{', '}'],   cls: 'safe' },
    while_let:      { shape: ['{', '}'],   cls: 'safe' },
    check:          { shape: ['[', ']'],   cls: 'check' },
  };

  lines.push('');
  lines.push('  %% Terminal handling nodes');
  for (const kind of usedKinds) {
    const { shape: [open, close], cls } = kindDef[kind];
    const label = kindLabelPlain(kind);
    lines.push(`  h_${kind}${open}"${label}"${close}:::${cls}`);
  }

  // Edges
  lines.push('');
  lines.push('  %% Error flow edges');
  for (const { fromId, toId, label, count } of edgeMap.values()) {
    const edgeLabel = count > 1 ? `${label} ×${count}` : label;
    lines.push(`  ${fromId} -->|"${edgeLabel}"| ${toId}`);
  }

  return lines.join('\n');
}

export function formatMarkdown(tree: GlobalResultTree): string {
  const lines: string[] = [
    '# ErrorVis Result Handling Tree',
    '',
    `Generated: ${tree.generatedAt}`,
    ''
  ];

  // Section 1: per-function tree grouped by struct/file origin
  for (const group of tree.groups) {
    lines.push(group.kind === 'struct'
      ? `## \`${group.label}\` — ${group.filePath}`
      : `## ${group.filePath}`
    );
    lines.push('');

    for (const fn of group.functions) {
      lines.push(`### \`${fn.fnName}\` (line ${fn.line})`);
      lines.push('');
      for (const h of fn.handling) {
        const indent = '  '.repeat(h.depth);
        const loc = `${vscode.workspace.asRelativePath(h.uri)}:${h.range.start.line + 1}`;
        const via = h.via ? ` ↳ via \`${h.via}\`` : '';
        lines.push(`${indent}- **${kindLabelPlain(h.kind)}**${via} — \`${loc}\``);
        lines.push(`${indent}  \`${h.lineText}\``);
      }
      lines.push('');
    }
  }

  // Section 2: inverted view — grouped by handling call site
  const callSites = buildCallSiteIndex(tree);
  if (callSites.size > 0) {
    lines.push('---', '', '## Handling by Call Site', '');

    // Group call sites by file
    const byFile = new Map<string, CallSite[]>();
    for (const site of callSites.values()) {
      const list = byFile.get(site.filePath) ?? [];
      list.push(site);
      byFile.set(site.filePath, list);
    }

    const sortedFiles = [...byFile.keys()].sort();
    for (const filePath of sortedFiles) {
      const sites = byFile.get(filePath)!.sort((a, b) => a.line - b.line);
      lines.push(`### \`${filePath}\``, '');
      lines.push('| Line | Handler | Function |');
      lines.push('|------|---------|----------|');
      for (const site of sites) {
        for (const entry of site.entries) {
          const via = entry.via ? ` ↳ via \`${entry.via}\`` : '';
          lines.push(`| ${site.line} | \`${kindLabelPlain(entry.kind)}\`${via} | \`${entry.fnLabel}\` |`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function showResultPicker(
  symbolName: string,
  locations: HandlingLocation[],
  editor: vscode.TextEditor
): Promise<void> {
  const originalUri = editor.document.uri;
  const originalPosition = editor.selection.active;
  const originalVisible = editor.visibleRanges[0];

  type PickItem = vscode.QuickPickItem & { location?: HandlingLocation };

  const sorted = [...locations].sort((a, b) =>
    a.depth !== b.depth
      ? a.depth - b.depth
      : vscode.workspace.asRelativePath(a.uri).localeCompare(vscode.workspace.asRelativePath(b.uri))
  );

  const items: PickItem[] = [];
  let lastDepth = -1;
  let lastFile = '';

  for (const loc of sorted) {
    const relPath = vscode.workspace.asRelativePath(loc.uri);
    if (loc.depth !== lastDepth) {
      const depthLabel = loc.depth === 0
        ? 'Direct usages'
        : `Propagated — depth ${loc.depth}${loc.via ? ` via ${loc.via}` : ''}`;
      items.push({ label: depthLabel, kind: vscode.QuickPickItemKind.Separator });
      lastFile = '';
      lastDepth = loc.depth;
    }
    if (relPath !== lastFile) {
      items.push({ label: relPath, kind: vscode.QuickPickItemKind.Separator });
      lastFile = relPath;
    }
    items.push({
      label: kindLabel(loc.kind),
      description: `line ${loc.range.start.line + 1}`,
      detail: loc.lineText,
      location: loc,
      alwaysShow: true
    });
  }

  const maxDepth = locations.reduce((m, l) => Math.max(m, l.depth), 0);
  const levelLabel = maxDepth > 0 ? ` across ${maxDepth + 1} level(s)` : '';
  const pick = vscode.window.createQuickPick<PickItem>();
  pick.title = `Result usages of "${symbolName}" — ${locations.length} found${levelLabel}`;
  pick.items = items;
  pick.matchOnDescription = true;
  pick.matchOnDetail = true;

  // Live preview as user moves through items
  pick.onDidChangeActive(async active => {
    const item = active[0];
    if (!item?.location) { return; }
    const doc = await vscode.workspace.openTextDocument(item.location.uri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: true,
      selection: item.location.range
    });
  });

  pick.onDidAccept(async () => {
    const selected = pick.selectedItems[0];
    pick.hide();
    if (!selected?.location) { return; }
    const doc = await vscode.workspace.openTextDocument(selected.location.uri);
    await vscode.window.showTextDocument(doc, {
      preview: false,
      selection: selected.location.range
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
