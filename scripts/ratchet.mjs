#!/usr/bin/env node
// Ratchet: known debt that may shrink but never grow.
//
// Each counter is a pattern we want out of the codebase but can't ban
// outright today without a refactor. CI fails when a count goes up. When a
// count goes down, lower the baseline in scripts/ratchet.json in the same PR
// so nobody can spend the slack later. When it reaches 0, turn it into a hard
// rule (lint, boundary check) and delete the counter.
//
// Usage: node scripts/ratchet.mjs           (exit 1 if any count exceeds baseline)
//        node scripts/ratchet.mjs --update  (rewrite baselines to current counts)

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'scripts', 'ratchet.json');
const UPDATE = process.argv.includes('--update');

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'src-tauri' || entry.name.startsWith('.')) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, out);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function countMatches(files, re) {
    let n = 0;
    const where = [];
    for (const f of files) {
        const hits = (fs.readFileSync(f, 'utf8').match(re) ?? []).length;
        if (hits) {
            n += hits;
            where.push(`${path.relative(ROOT, f)} (${hits})`);
        }
    }
    return {n, where};
}

const desktop = walk(path.join(ROOT, 'desktop', 'src'));
const serverApi = walk(path.join(ROOT, 'server', 'src', 'api'));

const COUNTERS = {
    'desktop.useEffect': {
        why: 'useEffect is where agents hide state sync and leak subscriptions. Prefer event handlers, derived state, or a lib/ helper that owns the lifecycle.',
        measure: () => countMatches(desktop, /\buseEffect\(/g),
    },
    'server.api-imports-store': {
        why: 'api/ should call app/, which owns permissions and hooks. Importing store/ from api/ skips that layer.',
        measure: () => countMatches(serverApi, /^\s*import\s+(?!type\s)[^'"]*from\s+'\.\.\/store\//gm),
    },
};

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
const current = {};
let failed = false;
let shrank = false;

for (const [name, c] of Object.entries(COUNTERS)) {
    const {n, where} = c.measure();
    current[name] = n;
    const base = baseline[name];
    if (base === undefined) {
        console.log(`• ${name}: ${n} (no baseline yet)`);
    } else if (n > base) {
        failed = true;
        console.error(`✗ ${name}: ${n}, baseline is ${base}. ${c.why}\n    ${where.join('\n    ')}`);
    } else if (n < base) {
        shrank = true;
        console.log(`↓ ${name}: ${n}, down from ${base}. Lower the baseline: node scripts/ratchet.mjs --update`);
    } else {
        console.log(`• ${name}: ${n} (at baseline)`);
    }
}

if (UPDATE) {
    fs.writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
    console.log(`wrote ${path.relative(ROOT, BASELINE)}`);
    process.exit(0);
}
if (failed) {
    process.exit(1);
}
if (shrank && process.env.CI) {
    console.error('A ratchet count went down but scripts/ratchet.json was not lowered. Run: node scripts/ratchet.mjs --update');
    process.exit(1);
}
console.log('✓ ratchet holds');
