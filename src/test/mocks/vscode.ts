/**
 * Minimal vscode mock for unit tests that exercise pure logic (classifyLine, etc.)
 * Only the symbols referenced at module-load time in resultFinder.ts are needed.
 */

export class Uri {
  static file(path: string): Uri { return new Uri(path); }
  constructor(public fsPath: string) {}
  toString(): string { return `file://${this.fsPath}`; }
}

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  constructor(
    public start: Position,
    public end: Position
  ) {}
  contains(_pos: Position): boolean { return false; }
}

export const SymbolKind = {
  Function: 11,
  Method: 5,
};

export const commands = {
  executeCommand: async () => undefined,
};

export const workspace = {
  openTextDocument: async () => undefined,
};
