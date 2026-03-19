// Inject the vscode mock before any module that imports 'vscode' is loaded.
// Node's require cache lets us register a fake module under the 'vscode' key.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
const originalLoad = Module._load;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === 'vscode') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./mocks/vscode');
  }
  return originalLoad.call(this, request, parent, isMain);
};
