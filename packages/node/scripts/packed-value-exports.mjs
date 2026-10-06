/** Compare the installed declarations' value surface with actual runtime exports. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

export async function verifyPackedValueExports({ consumerRoot, runtimeExports }) {
  const specifiers = Object.keys(runtimeExports);
  const source = specifiers.map((specifier, index) =>
    'import * as entry' + index + ' from ' + JSON.stringify(specifier) + ';').join('\n');
  for (const extension of ['mts', 'cts']) {
    const path = resolve(consumerRoot, 'value-exports.' + extension);
    await writeFile(path, source);
    const program = ts.createProgram([path], {
      target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, skipLibCheck: true, types: [], noEmit: true,
    });
    const errors = ts.getPreEmitDiagnostics(program);
    assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (name) => name, getCurrentDirectory: () => consumerRoot,
      getNewLine: () => '\n',
    }));
    const checker = program.getTypeChecker();
    const imports = program.getSourceFile(path).statements;
    for (const [index, statement] of imports.entries()) {
      // typeof namespace includes values, excluding interfaces and type-only exports.
      const namespace = statement.importClause.namedBindings.name;
      const declared = checker.getTypeAtLocation(namespace).getProperties()
        .map((symbol) => symbol.getName()).sort();
      assert.deepEqual(declared, runtimeExports[specifiers[index]],
        extension + ' declaration/runtime value exports differ for ' + specifiers[index]);
    }
  }
}
