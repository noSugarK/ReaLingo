import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise setup logic with injected OS boundaries; keep Vue refs/computeds real.
export function vueScript(url, bindings, exposed) {
  const source = readFileSync(url, 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [() => node => ts.factory.updateSourceFile(node,
      node.statements.filter(statement => !ts.isImportDeclaration(statement)))] },
  });
  return new Function(...Object.keys(bindings), outputText.replace(/export \{\};?\s*$/, '') + `\nreturn { ${exposed.join(', ')} };`)(...Object.values(bindings));
}
