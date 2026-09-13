#!/usr/bin/env node
/**
 * Fails if the TypeScript Permission union and the seeded SQL catalog drift.
 *
 * A key that exists in one but not the other is a silent authorization bug:
 * requirePermission() type-checks against a key no role can hold, so the guard
 * never passes and the feature is unreachable — or worse, a SQL policy
 * references a key the UI never offers.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ts = readFileSync('src/modules/core/rbac/permissions.ts', 'utf8');
const tsKeys = new Set(
  [...ts.matchAll(/^\s*'([a-z][a-z0-9_.]+)',$/gm)]
    .map((m) => m[1])
    .filter((k) => k.includes('.')),
);

const migrationsDir = 'supabase/migrations';
const sqlKeys = new Set();
for (const file of readdirSync(migrationsDir).sort()) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  // Matches rows of the permissions seed: ('key', 'group', module, 'desc', bool)
  for (const m of sql.matchAll(/\(\s*'([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)'\s*,\s*'[a-z]+'\s*,/g)) {
    sqlKeys.add(m[1]);
  }
}

const missingInSql = [...tsKeys].filter((k) => !sqlKeys.has(k));
const missingInTs = [...sqlKeys].filter((k) => !tsKeys.has(k));

if (missingInSql.length || missingInTs.length) {
  if (missingInSql.length) {
    console.error('Declared in TypeScript but never seeded in SQL:\n  ' + missingInSql.join('\n  '));
  }
  if (missingInTs.length) {
    console.error('Seeded in SQL but missing from the Permission union:\n  ' + missingInTs.join('\n  '));
  }
  process.exit(1);
}

console.log(`permission catalog in sync — ${tsKeys.size} keys`);
