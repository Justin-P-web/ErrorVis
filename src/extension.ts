import * as vscode from 'vscode';
import * as path from 'path';
import { findHandlingTree, kindLabel, HandlingLocation, buildGlobalResultTree, GlobalResultTree, ResultGroup, HandlingKind } from './resultFinder';
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
  const mdUri = vscode.Uri.file(mdPath);

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

  const basePath = jsonPath.replace(/\.json$/i, '');
  const mmdDiagrams = formatMermaid(tree);
  const mmdUris: vscode.Uri[] = [];
  for (const { filePath, content } of mmdDiagrams) {
    const safeName = filePath.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const mmdFileUri = vscode.Uri.file(`${basePath}-${safeName}.mmd`);
    await vscode.workspace.fs.writeFile(mmdFileUri, encoder.encode(content));
    mmdUris.push(mmdFileUri);
  }

  const totalFns = tree.groups.reduce((n, g) => n + g.functions.length, 0);
  const action = await vscode.window.showInformationMessage(
    `ErrorVis: Result tree exported — ${totalFns} function(s) across ${tree.groups.length} group(s). ${mmdUris.length} Mermaid diagram(s) written.`,
    'Open Mermaid',
    'Open Markdown',
    'Open JSON'
  );
  if (action === 'Open Mermaid') {
    if (mmdUris.length === 1) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mmdUris[0]));
    } else if (mmdUris.length > 1) {
      const items = mmdDiagrams.map((d, i) => ({ label: d.filePath, uri: mmdUris[i] }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a file diagram to open' });
      if (picked) {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(picked.uri));
      }
    }
  } else if (action === 'Open Markdown') {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mdUri));
  } else if (action === 'Open JSON') {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(saveUri));
  }
}

export interface CallSiteEntry { fnLabel: string; kind: HandlingKind; via?: string; fnFilePath: string; fnLine: number }
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
        map.get(key)!.entries.push({ fnLabel, kind: h.kind, via: h.via, fnFilePath: fn.filePath, fnLine: fn.line });
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

export interface MermaidDiagram { filePath: string; content: string }

export function formatMermaid(tree: GlobalResultTree): MermaidDiagram[] {
  // Bucket groups by their source file
  const byFile = new Map<string, ResultGroup[]>();
  for (const group of tree.groups) {
    const arr = byFile.get(group.filePath);
    if (arr) { arr.push(group); }
    else { byFile.set(group.filePath, [group]); }
  }

  return [...byFile.entries()].map(([filePath, groups]) =>
    ({ filePath, content: formatMermaidForFile(filePath, groups) })
  );
}

function formatMermaidForFile(filePath: string, groups: ResultGroup[]): string {
  const safeFnId = (name: string) =>
    'fn_' + name.replace(/[^a-zA-Z0-9]/g, '_');
  const safeLocId = (locFilePath: string, line: number) =>
    'loc_' + locFilePath.replace(/[^a-zA-Z0-9]/g, '_') + '_' + line;

  // Collect all source function names in this file
  const sourceFns = new Set<string>();
  for (const group of groups) {
    for (const fn of group.functions) {
      sourceFns.add(fn.fnName);
    }
  }

  // Collect pass-through functions: appear in loc.via but are not themselves sources
  const passthroughFns = new Set<string>();
  for (const group of groups) {
    for (const fn of group.functions) {
      for (const loc of fn.handling) {
        if (loc.via && !sourceFns.has(loc.via)) {
          passthroughFns.add(loc.via);
        }
      }
    }
  }

  // Track node IDs already defined as source or passthrough — handler nodes reuse these
  const definedFnIds = new Set<string>();
  for (const fn of sourceFns) { definedFnIds.add(safeFnId(fn)); }
  for (const fn of passthroughFns) { definedFnIds.add(safeFnId(fn)); }

  // Collect handler nodes for non-propagating locations, keyed by inFunction name
  // (or filePath:line as fallback when inFunction is unavailable)
  type HandlerNode = { nodeId: string; label: string; locFilePath: string };
  const handlerNodes = new Map<string, HandlerNode>();
  for (const group of groups) {
    for (const fn of group.functions) {
      for (const loc of fn.handling) {
        if ((loc.kind === 'question_mark' || loc.kind === 'return') && loc.depth > 0) { continue; }
        const locFilePath = vscode.workspace.asRelativePath(loc.uri);
        if (loc.inFunction) {
          const key = loc.inFunction;
          if (!handlerNodes.has(key)) {
            const label = loc.inStruct ? `${loc.inStruct}::${loc.inFunction}` : loc.inFunction;
            handlerNodes.set(key, { nodeId: safeFnId(loc.inFunction), label, locFilePath });
          }
        } else {
          const line = loc.range.start.line + 1;
          const key = `${locFilePath}:${line}`;
          if (!handlerNodes.has(key)) {
            const shortFile = path.basename(locFilePath);
            handlerNodes.set(key, { nodeId: safeLocId(locFilePath, line), label: `${shortFile}:${line}`, locFilePath });
          }
        }
      }
    }
  }

  // Build edge set: (fromId, toId) — deduplicated
  const edgeSet = new Set<string>();
  const edges: { fromId: string; toId: string }[] = [];
  const addEdge = (fromId: string, toId: string) => {
    const key = `${fromId}→${toId}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push({ fromId, toId });
    }
  };

  for (const group of groups) {
    for (const fn of group.functions) {
      const srcId = safeFnId(fn.fnName);
      for (const loc of fn.handling) {
        const locFilePath = vscode.workspace.asRelativePath(loc.uri);
        // The immediate upstream node: via function if present, otherwise the source itself
        const immediateId = loc.via ? safeFnId(loc.via) : srcId;

        // Always emit the via-chain edge
        if (loc.via) {
          addEdge(srcId, safeFnId(loc.via));
        }

        if (loc.kind === 'question_mark' || loc.kind === 'return') {
          // Propagation point: connect immediate node to the function that contains this propagation
          if (loc.inFunction) {
            addEdge(immediateId, safeFnId(loc.inFunction));
          }
        } else {
          // Terminal handler: connect immediate node to the handler function node
          const handlerKey = loc.inFunction ?? `${locFilePath}:${loc.range.start.line + 1}`;
          const handlerNode = handlerNodes.get(handlerKey);
          if (handlerNode) {
            addEdge(immediateId, handlerNode.nodeId);
          }
        }
      }
    }
  }

  const lines: string[] = [
    '%%{init: {"theme":"neutral"}}%%',
    `%% ${filePath}`,
    'graph TD',
    '  classDef source fill:#4A90D9,stroke:#2C5F8A,color:#fff',
    '  classDef passthrough fill:#F5A623,stroke:#C67D0E,color:#333,stroke-dasharray:5 5',
    '  classDef callsite fill:#ECF0F1,stroke:#95A5A6,color:#333',
    '',
    '  %% Source functions (return Result/Option)',
  ];

  // File-level subgraph containing all source nodes for this file
  const fileSgId = 'sg_file_' + filePath.replace(/[^a-zA-Z0-9]/g, '_');
  lines.push(`  subgraph ${fileSgId} ["${filePath}"]`);

  const emittedFns = new Set<string>();

  // Emit struct subgraphs nested inside the file subgraph
  for (const group of groups) {
    if (group.kind === 'struct') {
      const sgId = 'sg_' + group.label.replace(/[^a-zA-Z0-9]/g, '_');
      lines.push(`    subgraph ${sgId} ["${group.label}"]`);
      for (const fn of group.functions) {
        lines.push(`      ${safeFnId(fn.fnName)}["${fn.fnName}"]:::source`);
        emittedFns.add(fn.fnName);
      }
      lines.push('    end');
    }
  }

  // Emit ungrouped functions (file-kind groups) directly inside the file subgraph
  for (const group of groups) {
    if (group.kind === 'file') {
      for (const fn of group.functions) {
        if (!emittedFns.has(fn.fnName)) {
          lines.push(`    ${safeFnId(fn.fnName)}["${fn.fnName}"]:::source`);
          emittedFns.add(fn.fnName);
        }
      }
    }
  }

  lines.push('  end');

  if (passthroughFns.size > 0) {
    lines.push('');
    lines.push('  %% Pass-through functions (propagate without handling)');
    for (const fn of passthroughFns) {
      lines.push(`  ${safeFnId(fn)}(["${fn}"]):::passthrough`);
    }
  }

  // Group handler function nodes by their file, only emit nodes not already defined as source/passthrough
  type HandlerFileEntry = { nodeId: string; label: string };
  const byLocFile = new Map<string, HandlerFileEntry[]>();
  for (const node of handlerNodes.values()) {
    if (definedFnIds.has(node.nodeId)) { continue; } // already defined as source or passthrough
    const arr = byLocFile.get(node.locFilePath) ?? [];
    arr.push({ nodeId: node.nodeId, label: node.label });
    byLocFile.set(node.locFilePath, arr);
  }

  if (byLocFile.size > 0) {
    lines.push('');
    lines.push('  %% Handler function nodes');
    for (const [locFile, nodes] of byLocFile) {
      const sgId = 'sg_handlers_' + locFile.replace(/[^a-zA-Z0-9]/g, '_');
      lines.push(`  subgraph ${sgId} ["${locFile}"]`);
      for (const node of nodes) {
        lines.push(`    ${node.nodeId}["${node.label}"]:::callsite`);
      }
      lines.push('  end');
    }
  }

  lines.push('');
  lines.push('  %% Error flow edges');
  for (const { fromId, toId } of edges) {
    lines.push(`  ${fromId} --> ${toId}`);
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

  // Section 2: inverted view — grouped by handling call site (propagation-only sites excluded)
  const callSites = buildCallSiteIndex(tree);
  if (callSites.size > 0) {
    lines.push('---', '', '## Handling by Call Site', '');

    // Group call sites by file, skipping sites with only propagating entries
    const byFile = new Map<string, CallSite[]>();
    for (const site of callSites.values()) {
      const hasRealHandling = site.entries.some(
        e => e.kind !== 'question_mark' && e.kind !== 'return'
      );
      if (!hasRealHandling) { continue; }
      const list = byFile.get(site.filePath) ?? [];
      list.push(site);
      byFile.set(site.filePath, list);
    }

    const sortedFiles = [...byFile.keys()].sort();
    for (const filePath of sortedFiles) {
      const sites = byFile.get(filePath)!.sort((a, b) => a.line - b.line);
      lines.push(`### \`${filePath}\``, '');
      lines.push('| Line | Handler | Origin Function |');
      lines.push('|------|---------|-----------------|');
      for (const site of sites) {
        for (const entry of site.entries) {
          if (entry.kind === 'question_mark' || entry.kind === 'return') { continue; }
          const via = entry.via ? ` ↳ via \`${entry.via}\`` : '';
          lines.push(`| ${site.line} | \`${kindLabelPlain(entry.kind)}\`${via} | \`${entry.fnLabel}\` — \`${entry.fnFilePath}:${entry.fnLine}\` |`);
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
