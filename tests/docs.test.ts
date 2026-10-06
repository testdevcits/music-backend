import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const spec = JSON.parse(readFileSync(join(__dirname, '../docs/openapi.json'), 'utf8'));
test('OpenAPI has resolvable references, unique operations and complete static route coverage', () => {
  const identifiers = new Set<string>();
  for (const path of Object.values(spec.paths) as any[])
    for (const operation of Object.values(path) as any[]) {
      assert.ok(!identifiers.has(operation.operationId));
      identifiers.add(operation.operationId);
      assert.ok(operation.responses);
    }
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      const resolved = node.$ref
        .slice(2)
        .split('/')
        .reduce((value: any, key: string) => value?.[key], spec);
      assert.ok(resolved, `Missing ${node.$ref}`);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(spec);
  let expectedOperations = 0;
  for (const module of readdirSync(join(__dirname, '../src/modules'))) {
    const text = readFileSync(join(__dirname, '../src/modules', module, 'routes.ts'), 'utf8');
    for (const match of text.matchAll(/\w+Routes\.(get|post|patch|put|delete)\('([^']+)'/g)) {
      const path =
        (module === 'admin' ? '/admin' : module === 'auth' ? '/auth' : '') +
        match[2].replace(/:(\w+)/g, '{$1}');
      if (path.startsWith('/media/') || path.endsWith('/audio')) continue;
      expectedOperations += 1;
      assert.ok(spec.paths[path]?.[match[1]], `Undocumented ${match[1]} ${path}`);
    }
  }
  assert.ok(identifiers.size >= expectedOperations, `Expected at least ${expectedOperations} documented operations, found ${identifiers.size}.`);
});
