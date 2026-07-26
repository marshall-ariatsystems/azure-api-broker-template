#!/usr/bin/env node
// Read-only progress renderer for the vertical-scoped directive backlog.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || process.cwd());
const directives = path.join(root, '_directives');
const verticalRoot = path.join(directives, 'verticals');
const registryPath = path.join(directives, 'registry.jsonl');
const driversPath = path.join(verticalRoot, 'DRIVERS.md');

async function text(file) {
  try { return await readFile(file, 'utf8'); } catch { return ''; }
}

function latestStates(registry) {
  const states = new Map();
  for (const line of registry.split('\n')) {
    try {
      const record = JSON.parse(line);
      if (record.id && record.state) states.set(record.id, record.state);
    } catch { /* incomplete or legacy line: ignore */ }
  }
  return states;
}

function edRows(markdown, states, present) {
  const ownedIds = markdown.split('\n').flatMap((line) => {
    const match = /^\|\s*`(ED(?:-V\d{3}-\d{3}|-\d{3}))`(?:\s*\([^)]*\))?\s*\|/.exec(line);
    return match ? [match[1]] : [];
  });
  return ownedIds.map((id) => {
    return { id, state: states.get(id) || (present.has(id) ? 'AUTHORED' : 'PLANNED') };
  }).filter((row, index, rows) => rows.findIndex((candidate) => candidate.id === row.id) === index);
}

const [registry, entries, edFiles] = await Promise.all([
  text(registryPath),
  readdir(verticalRoot, { withFileTypes: true }).catch(() => []),
  readdir(path.join(directives, 'ED')).catch(() => []),
]);
const drivers = new Map([...((await text(driversPath)).matchAll(/^\|\s*(V-\d{3})\s*\|\s*`([^`]+)`\s*\|.*\|\s*(\w+)\s*\|$/gm))]
  .map((match) => [match[1], { name: match[2], state: match[3] }]));
const states = latestStates(registry);
const present = new Set(edFiles.filter((file) => file.endsWith('.md') && !file.endsWith('-launch.md')).map((file) => file.replace(/\.md$/, '')));
const verticals = [];
for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const file = path.join(verticalRoot, entry.name, 'vertical.md');
  const body = await text(file);
  const key = /^vertical:\s*(V-\d{3})$/m.exec(body)?.[1] || entry.name;
  const title = /^title:\s*(.+)$/m.exec(body)?.[1] || entry.name;
  verticals.push({ key, title, rows: edRows(body, states, present) });
}

const width = 21;
console.log(`Tessera vertical execution — ${new Date().toLocaleString()}`);
console.log('Source: _directives/registry.jsonl + _directives/verticals/*/vertical.md');
console.log('');
for (const vertical of verticals) {
  const driver = drivers.get(vertical.key);
  console.log(`${vertical.key.padEnd(6)} ${vertical.title}${driver ? `  [${driver.name}: ${driver.state}]` : ''}`);
  for (const row of vertical.rows) console.log(`  ${row.id.padEnd(width)} ${row.state}`);
}
