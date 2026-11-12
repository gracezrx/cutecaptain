#!/usr/bin/env node
// Layer-boundary check. Fails CI when a file imports across a boundary that
// docs/ARCHITECTURE.md says must not be crossed. The rules are the structure
// of the codebase, made mechanical, so an agent (or a person) can't take the
// shortcut even by accident.
//
// Server layers, top to bottom:  api → app → (agents, connectors, llm) → store → db
//   - store/ and db/ never import anything above them
//   - app/ never imports api/
//   - agents/, connectors/, llm/ never import api/
//   - util/ and shared/ are leaves: they import nothing above them
//   - `import type` never counts: types don't couple layers at runtime
// Client:
//   - desktop/ reaches the server only through server/src/shared/
//
// api → store (skipping app) is a known debt tracked by scripts/ratchet.mjs,
// not a hard failure here, until the remaining cases are moved behind app/.
//
// Usage: node scripts/check-boundaries.mjs            (exit 1 on violations)
//        node scripts/check-boundaries.mjs --list     (print every edge)

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = process.argv.includes('--list');

const SERVER_LAYER_RULES = [
    {from: ['store', 'db'], forbid: ['app', 'api', 'agents', 'realtime', 'jobs', 'connectors', 'files', 'llm'], why: 'store/db sit at the bottom: they know nothing about the layers above'},
    {from: ['app'], forbid: ['api'], why: 'app is called by api, never the reverse'},
    {from: ['agents', 'connectors', 'llm'], forbid: ['api'], why: 'these run under app and never call the HTTP layer'},
    {from: ['util', 'shared'], forbid: ['api', 'app', 'agents', 'store', 'db', 'realtime', 'jobs', 'connectors', 'files', 'llm'], why: 'leaf modules import nothing above them'},
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'src-tauri' || entry.name.startsWith('.')) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, out);
        } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out;
}

function importsOf(file) {
    const src = fs.readFileSync(file, 'utf8');
    const specs = [];
    for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (spec && spec.startsWith('.')) {
            specs.push(spec);
        }
    }
    return specs;
}

function layerOf(serverSrc, file) {
    const rel = path.relative(serverSrc, file);
    if (rel.startsWith('..')) {
        return null;
    }
    const top = rel.split(path.sep)[0];
    return top.includes('.') ? '(root)' : top;
}

const violations = [];
const edges = [];

const serverSrc = path.join(ROOT, 'server', 'src');
for (const file of walk(serverSrc)) {
    const fromLayer = layerOf(serverSrc, file);
    for (const spec of importsOf(file)) {
        const target = path.resolve(path.dirname(file), spec);
        const toLayer = layerOf(serverSrc, target);
        if (!toLayer || toLayer === fromLayer) {
            continue;
        }
        edges.push(`${fromLayer} → ${toLayer}  (${path.relative(ROOT, file)} imports ${spec})`);
        for (const rule of SERVER_LAYER_RULES) {
            if (rule.from.includes(fromLayer) && rule.forbid.includes(toLayer)) {
                violations.push(`${path.relative(ROOT, file)} imports ${spec}\n    ${fromLayer}/ must not import ${toLayer}/: ${rule.why}`);
            }
        }
    }
}

const desktopSrc = path.join(ROOT, 'desktop', 'src');
for (const file of walk(desktopSrc)) {
    for (const spec of importsOf(file)) {
        const target = path.resolve(path.dirname(file), spec);
        const rel = path.relative(serverSrc, target);
        if (!rel.startsWith('..') && !rel.startsWith('shared' + path.sep)) {
            violations.push(`${path.relative(ROOT, file)} imports ${spec}\n    desktop/ may only reach the server through server/src/shared/`);
        }
    }
}

if (LIST) {
    console.log([...new Set(edges)].sort().join('\n'));
}

if (violations.length) {
    console.error(`\n✗ ${violations.length} layer-boundary violation${violations.length === 1 ? '' : 's'}:\n`);
    for (const v of violations) {
        console.error('  ' + v + '\n');
    }
    console.error('Rules live in scripts/check-boundaries.mjs and docs/ARCHITECTURE.md.');
    process.exit(1);
}
console.log('✓ layer boundaries hold');
