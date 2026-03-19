import * as assert from 'assert';
import {
  kindLabelPlain,
  buildCallSiteIndex,
  formatJson,
  formatMarkdown,
  formatMermaid,
} from '../extension';
import { GlobalResultTree, HandlingKind } from '../resultFinder';

// ---------------------------------------------------------------------------
// Helpers for building fixture data
// ---------------------------------------------------------------------------

const vscode = require('vscode') as typeof import('./mocks/vscode');

function makeUri(fsPath: string) {
  return vscode.Uri.file(fsPath);
}

function makeRange(line: number) {
  return new vscode.Range(new vscode.Position(line - 1, 0), new vscode.Position(line - 1, 80));
}

function makeHandling(
  kind: HandlingKind,
  fsPath: string,
  line: number,
  opts: { depth?: number; via?: string; lineText?: string } = {}
) {
  return {
    kind,
    uri: makeUri(fsPath),
    range: makeRange(line),
    depth: opts.depth ?? 0,
    via: opts.via,
    lineText: opts.lineText ?? `/* ${kind} */`,
  };
}

/** A minimal single-file-group tree with one function and two handlers. */
function makeSimpleTree(): GlobalResultTree {
  return {
    generatedAt: '2026-03-19T00:00:00.000Z',
    groups: [
      {
        kind: 'file',
        label: 'src/main.rs',
        filePath: 'src/main.rs',
        functions: [
          {
            fnName: 'parse_config',
            filePath: 'src/main.rs',
            line: 10,
            handling: [
              makeHandling('unwrap', 'src/caller.rs', 5,  { lineText: 'cfg.unwrap()' }),
              makeHandling('match',  'src/caller.rs', 20, { lineText: 'match cfg {' }),
            ],
          },
        ],
      },
    ],
  };
}

/** A struct-group tree with two methods (triggers subgraph in Mermaid). */
function makeStructTree(): GlobalResultTree {
  return {
    generatedAt: '2026-03-19T00:00:00.000Z',
    groups: [
      {
        kind: 'struct',
        label: 'Config',
        filePath: 'src/config.rs',
        functions: [
          {
            fnName: 'load',
            filePath: 'src/config.rs',
            line: 12,
            handling: [
              makeHandling('question_mark', 'src/main.rs', 8,  { lineText: 'Config::load()?' }),
              makeHandling('expect',        'src/lib.rs',  33, { lineText: 'Config::load().expect("cfg")' }),
            ],
          },
          {
            fnName: 'save',
            filePath: 'src/config.rs',
            line: 30,
            handling: [
              makeHandling('if_let', 'src/main.rs', 15, { lineText: 'if let Ok(v) = cfg.save() {' }),
            ],
          },
        ],
      },
    ],
  };
}

/** A tree where a handler appears via propagation. */
function makePropagatedTree(): GlobalResultTree {
  return {
    generatedAt: '2026-03-19T00:00:00.000Z',
    groups: [
      {
        kind: 'file',
        label: 'src/lib.rs',
        filePath: 'src/lib.rs',
        functions: [
          {
            fnName: 'read_file',
            filePath: 'src/lib.rs',
            line: 5,
            handling: [
              makeHandling('unwrap',        'src/main.rs', 10, { depth: 0 }),
              makeHandling('question_mark', 'src/util.rs', 7,  { depth: 1, via: 'process_file' }),
            ],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// kindLabelPlain
// ---------------------------------------------------------------------------
describe('kindLabelPlain()', () => {
  const cases: [HandlingKind, string][] = [
    ['unwrap',         '.unwrap()'],
    ['expect',         '.expect(...)'],
    ['unwrap_or',      '.unwrap_or*(...)'],
    ['map_combinator', 'combinator'],
    ['question_mark',  '?'],
    ['return',         'return'],
    ['match',          'match'],
    ['if_let',         'if let'],
    ['while_let',      'while let'],
    ['check',          '.is_ok()/.is_err()'],
  ];

  for (const [kind, expected] of cases) {
    it(`maps '${kind}' → '${expected}'`, () => {
      assert.strictEqual(kindLabelPlain(kind), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// buildCallSiteIndex
// ---------------------------------------------------------------------------
describe('buildCallSiteIndex()', () => {
  it('returns a Map', () => {
    const result = buildCallSiteIndex(makeSimpleTree());
    assert.ok(result instanceof Map);
  });

  it('creates one entry per unique file:line combination', () => {
    const tree = makeSimpleTree();
    const index = buildCallSiteIndex(tree);
    // Two handlers at different lines → two entries
    assert.strictEqual(index.size, 2);
    assert.ok(index.has('src/caller.rs:5'));
    assert.ok(index.has('src/caller.rs:20'));
  });

  it('stores filePath and line correctly', () => {
    const index = buildCallSiteIndex(makeSimpleTree());
    const site = index.get('src/caller.rs:5')!;
    assert.strictEqual(site.filePath, 'src/caller.rs');
    assert.strictEqual(site.line, 5);
  });

  it('stores lineText from the handling location', () => {
    const index = buildCallSiteIndex(makeSimpleTree());
    const site = index.get('src/caller.rs:5')!;
    assert.strictEqual(site.lineText, 'cfg.unwrap()');
  });

  it('uses plain fnName as fnLabel for file-kind groups', () => {
    const index = buildCallSiteIndex(makeSimpleTree());
    const site = index.get('src/caller.rs:5')!;
    assert.strictEqual(site.entries[0].fnLabel, 'parse_config');
  });

  it('uses "StructName::fnName" as fnLabel for struct-kind groups', () => {
    const index = buildCallSiteIndex(makeStructTree());
    const site = index.get('src/main.rs:8')!;
    assert.strictEqual(site.entries[0].fnLabel, 'Config::load');
  });

  it('merges multiple functions handled at the same file:line', () => {
    // Build a tree where two functions are called/handled at the exact same line
    const tree: GlobalResultTree = {
      generatedAt: '2026-03-19T00:00:00.000Z',
      groups: [
        {
          kind: 'file',
          label: 'src/lib.rs',
          filePath: 'src/lib.rs',
          functions: [
            {
              fnName: 'fn_a',
              filePath: 'src/lib.rs',
              line: 1,
              handling: [makeHandling('unwrap', 'src/main.rs', 5)],
            },
            {
              fnName: 'fn_b',
              filePath: 'src/lib.rs',
              line: 2,
              handling: [makeHandling('match', 'src/main.rs', 5)],
            },
          ],
        },
      ],
    };
    const index = buildCallSiteIndex(tree);
    assert.strictEqual(index.size, 1);
    const site = index.get('src/main.rs:5')!;
    assert.strictEqual(site.entries.length, 2);
    assert.deepStrictEqual(
      site.entries.map(e => e.fnLabel).sort(),
      ['fn_a', 'fn_b']
    );
  });

  it('preserves kind and via on each entry', () => {
    const index = buildCallSiteIndex(makePropagatedTree());
    const site = index.get('src/util.rs:7')!;
    assert.strictEqual(site.entries[0].kind, 'question_mark');
    assert.strictEqual(site.entries[0].via, 'process_file');
  });
});

// ---------------------------------------------------------------------------
// formatJson
// ---------------------------------------------------------------------------
describe('formatJson()', () => {
  it('produces valid JSON', () => {
    assert.doesNotThrow(() => JSON.parse(formatJson(makeSimpleTree())));
  });

  it('includes top-level generatedAt, groups, and callSites', () => {
    const obj = JSON.parse(formatJson(makeSimpleTree()));
    assert.ok('generatedAt' in obj, 'missing generatedAt');
    assert.ok(Array.isArray(obj.groups),    'groups should be an array');
    assert.ok(Array.isArray(obj.callSites), 'callSites should be an array');
  });

  it('preserves generatedAt timestamp', () => {
    const obj = JSON.parse(formatJson(makeSimpleTree()));
    assert.strictEqual(obj.generatedAt, '2026-03-19T00:00:00.000Z');
  });

  it('maps groups correctly', () => {
    const obj = JSON.parse(formatJson(makeSimpleTree()));
    assert.strictEqual(obj.groups.length, 1);
    const g = obj.groups[0];
    assert.strictEqual(g.kind, 'file');
    assert.strictEqual(g.label, 'src/main.rs');
    assert.strictEqual(g.functions.length, 1);
    assert.strictEqual(g.functions[0].fnName, 'parse_config');
  });

  it('includes handling entries inside functions', () => {
    const obj = JSON.parse(formatJson(makeSimpleTree()));
    const handling = obj.groups[0].functions[0].handling;
    assert.strictEqual(handling.length, 2);
    assert.strictEqual(handling[0].kind, 'unwrap');
    assert.strictEqual(handling[0].line, 5);
    assert.strictEqual(handling[0].filePath, 'src/caller.rs');
    assert.strictEqual(handling[0].lineText, 'cfg.unwrap()');
  });

  it('serialises callSites with filePath, line, lineText and handlers', () => {
    const obj = JSON.parse(formatJson(makeSimpleTree()));
    assert.strictEqual(obj.callSites.length, 2);
    const site = obj.callSites.find((s: { line: number }) => s.line === 5)!;
    assert.ok(site, 'call site at line 5 should exist');
    assert.strictEqual(site.filePath, 'src/caller.rs');
    assert.strictEqual(site.lineText, 'cfg.unwrap()');
    assert.ok(Array.isArray(site.handlers));
    assert.strictEqual(site.handlers[0].kind, 'unwrap');
    assert.strictEqual(site.handlers[0].function, 'parse_config');
  });

  it('sorts callSites by filePath then line', () => {
    const tree: GlobalResultTree = {
      generatedAt: '2026-03-19T00:00:00.000Z',
      groups: [
        {
          kind: 'file',
          label: 'src/lib.rs',
          filePath: 'src/lib.rs',
          functions: [
            {
              fnName: 'fn_x',
              filePath: 'src/lib.rs',
              line: 1,
              handling: [
                makeHandling('unwrap', 'src/b.rs', 10),
                makeHandling('match',  'src/a.rs', 5),
                makeHandling('check',  'src/a.rs', 2),
              ],
            },
          ],
        },
      ],
    };
    const obj = JSON.parse(formatJson(tree));
    const paths = obj.callSites.map((s: { filePath: string; line: number }) => `${s.filePath}:${s.line}`);
    assert.deepStrictEqual(paths, ['src/a.rs:2', 'src/a.rs:5', 'src/b.rs:10']);
  });

  it('sets via to null when absent', () => {
    const obj = JSON.parse(formatJson(makeSimpleTree()));
    assert.strictEqual(obj.callSites[0].handlers[0].via, null);
  });

  it('includes via value when present', () => {
    const obj = JSON.parse(formatJson(makePropagatedTree()));
    const site = obj.callSites.find((s: { line: number }) => s.line === 7)!;
    assert.strictEqual(site.handlers[0].via, 'process_file');
  });
});

// ---------------------------------------------------------------------------
// formatMarkdown
// ---------------------------------------------------------------------------
describe('formatMarkdown()', () => {
  it('starts with the standard header', () => {
    const md = formatMarkdown(makeSimpleTree());
    assert.ok(md.startsWith('# ErrorVis Result Handling Tree'), 'missing H1 header');
  });

  it('includes the generatedAt timestamp', () => {
    const md = formatMarkdown(makeSimpleTree());
    assert.ok(md.includes('2026-03-19T00:00:00.000Z'));
  });

  it('emits an H3 for each function with its line number', () => {
    const md = formatMarkdown(makeSimpleTree());
    assert.ok(md.includes('### `parse_config` (line 10)'));
  });

  it('renders file-kind group as H2 with file path', () => {
    const md = formatMarkdown(makeSimpleTree());
    assert.ok(md.includes('## src/main.rs'));
  });

  it('renders struct-kind group as H2 with struct label and file path', () => {
    const md = formatMarkdown(makeStructTree());
    assert.ok(md.includes('## `Config` — src/config.rs'));
  });

  it('includes kindLabelPlain output in handling list items', () => {
    const md = formatMarkdown(makeSimpleTree());
    assert.ok(md.includes('**.unwrap()**'));
    assert.ok(md.includes('**match**'));
  });

  it('includes file:line reference for each handler', () => {
    const md = formatMarkdown(makeSimpleTree());
    assert.ok(md.includes('src/caller.rs:5'));
    assert.ok(md.includes('src/caller.rs:20'));
  });

  it('renders via propagation chain in list items', () => {
    const md = formatMarkdown(makePropagatedTree());
    assert.ok(md.includes('↳ via `process_file`'), 'should show via chain');
  });

  it('includes "Handling by Call Site" section separator and header', () => {
    const md = formatMarkdown(makeSimpleTree());
    assert.ok(md.includes('---'), 'should include horizontal rule');
    assert.ok(md.includes('## Handling by Call Site'));
  });

  it('includes a file-level H3 in the call-site section', () => {
    const md = formatMarkdown(makeSimpleTree());
    assert.ok(md.includes('### `src/caller.rs`'));
  });

  it('includes Markdown table headers in the call-site section', () => {
    const md = formatMarkdown(makeSimpleTree());
    assert.ok(md.includes('| Line | Handler | Function |'));
    assert.ok(md.includes('|------|---------|----------|'));
  });

  it('includes table rows with correct data', () => {
    const md = formatMarkdown(makeSimpleTree());
    assert.ok(md.includes('| 5 |'));
    assert.ok(md.includes('| 20 |'));
    assert.ok(md.includes('`parse_config`'));
    assert.ok(md.includes('`.unwrap()`'));
  });

  it('omits call-site section when there are no handlers', () => {
    const emptyTree: GlobalResultTree = {
      generatedAt: '2026-03-19T00:00:00.000Z',
      groups: [
        {
          kind: 'file',
          label: 'src/lib.rs',
          filePath: 'src/lib.rs',
          functions: [{ fnName: 'foo', filePath: 'src/lib.rs', line: 1, handling: [] }],
        },
      ],
    };
    const md = formatMarkdown(emptyTree);
    assert.ok(!md.includes('## Handling by Call Site'), 'should not emit section for empty handlers');
  });
});

// ---------------------------------------------------------------------------
// formatMermaid
// ---------------------------------------------------------------------------
describe('formatMermaid()', () => {
  it('starts with the Mermaid init directive', () => {
    const mmd = formatMermaid(makeSimpleTree());
    assert.ok(mmd.startsWith('%%{init:'), 'should start with %%{init:');
  });

  it('declares graph TD', () => {
    const mmd = formatMermaid(makeSimpleTree());
    assert.ok(mmd.includes('graph TD'));
  });

  it('emits classDef for source and danger styles', () => {
    const mmd = formatMermaid(makeSimpleTree());
    assert.ok(mmd.includes('classDef source'));
    assert.ok(mmd.includes('classDef danger'));
  });

  it('emits a source node for each function', () => {
    const mmd = formatMermaid(makeSimpleTree());
    assert.ok(mmd.includes('fn_parse_config["parse_config"]:::source'));
  });

  it('emits a terminal handler node for each used kind', () => {
    const mmd = formatMermaid(makeSimpleTree());
    // unwrap and match are both used
    assert.ok(mmd.includes('h_unwrap'), 'should have unwrap handler node');
    assert.ok(mmd.includes('h_match'),  'should have match handler node');
    // question_mark is not used in simple tree
    assert.ok(!mmd.includes('h_question_mark'), 'should not emit unused handler nodes');
  });

  it('emits edges from source to terminal handlers', () => {
    const mmd = formatMermaid(makeSimpleTree());
    assert.ok(mmd.includes('fn_parse_config -->'));
  });

  it('wraps a struct group with 2+ functions in a subgraph block', () => {
    const mmd = formatMermaid(makeStructTree());
    assert.ok(mmd.includes('subgraph'), 'should include subgraph keyword');
    // Both methods should be indented inside the subgraph
    assert.ok(mmd.includes('fn_load["load"]:::source'));
    assert.ok(mmd.includes('fn_save["save"]:::source'));
  });

  it('does NOT wrap a single-function group in a subgraph', () => {
    const mmd = formatMermaid(makeSimpleTree());
    assert.ok(!mmd.includes('subgraph'), 'single-function group should not get a subgraph');
  });

  it('emits passthrough nodes for via-propagated functions', () => {
    const mmd = formatMermaid(makePropagatedTree());
    assert.ok(mmd.includes('fn_process_file'), 'should emit passthrough node');
    assert.ok(mmd.includes(':::passthrough'));
  });

  it('emits propagation edge from source to passthrough', () => {
    const mmd = formatMermaid(makePropagatedTree());
    assert.ok(mmd.includes('fn_read_file -->|"?"| fn_process_file'));
  });

  it('aggregates repeated edges with a count label', () => {
    const tree: GlobalResultTree = {
      generatedAt: '2026-03-19T00:00:00.000Z',
      groups: [
        {
          kind: 'file',
          label: 'src/lib.rs',
          filePath: 'src/lib.rs',
          functions: [
            {
              fnName: 'do_thing',
              filePath: 'src/lib.rs',
              line: 1,
              handling: [
                makeHandling('unwrap', 'src/a.rs', 5),
                makeHandling('unwrap', 'src/b.rs', 10),
              ],
            },
          ],
        },
      ],
    };
    const mmd = formatMermaid(tree);
    // Two unwrap edges should be merged into "×2"
    assert.ok(mmd.includes('×2'), 'repeated edges should show ×N count');
  });
});
