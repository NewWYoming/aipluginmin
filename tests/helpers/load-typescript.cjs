const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

// Compile the real service modules, replacing only explicit host boundaries.
// Each loader has an isolated cache; production imports/globals are not patched.
function createLoader(mocks = {}, globals = {}) {
  const cache = new Map();
  const overrides = new Map(
    Object.entries(mocks).map(([name, value]) => [path.resolve(root, name), value]),
  );
  function load(name) {
    let filename = path.resolve(root, name);
    if (!path.extname(filename)) {
      filename = overrides.has(`${filename}.ts`) || fs.existsSync(`${filename}.ts`)
        ? `${filename}.ts` : path.join(filename, 'index.ts');
    }
    if (overrides.has(filename)) return overrides.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      reportDiagnostics: true,
    });
    const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n',
    }));
    const injected = Object.keys(globals);
    const run = vm.runInThisContext(
      `(function(require, module, exports, ${injected.join(',')}) {\n${result.outputText}\n})`,
      { filename },
    );
    run(specifier => {
      if (!specifier.startsWith('.')) throw new Error(`Unexpected external import: ${specifier}`);
      return load(path.resolve(path.dirname(filename), specifier));
    }, module, module.exports, ...Object.values(globals));
    return module.exports;
  }
  return load;
}

module.exports = { createLoader };
