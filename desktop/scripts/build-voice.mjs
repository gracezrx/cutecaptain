// Builds the app's two Swift helpers for the app's target, as
// src-tauri/binaries/captain-<name>-<target>, which Tauri bundles next to the
// app:
// - captain-voice (src-tauri/voice/main.swift): speech recognition and voices
// - captain-desk (src-tauri/desk/main.swift): screenshots, clicks, keys and
//   reading apps, for agents working on this Mac
// Needs Xcode's command-line tools. Elsewhere it leaves empty placeholders,
// so the Rust core still builds (both are Mac-only).

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const tauri = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const host = execFileSync('rustc', ['-vV'], {encoding: 'utf8'}).match(/host: (\S+)/)?.[1];
const target = process.env.TAURI_ENV_TARGET_TRIPLE || host;

const HELPERS = [
    {name: 'captain-voice', dir: 'voice', plist: true},
    {name: 'captain-desk', dir: 'desk', plist: false},
];

for (const helper of HELPERS) {
    const out = path.join(tauri, 'binaries', `${helper.name}-${target}`);
    if (process.platform !== 'darwin' || !target.endsWith('apple-darwin')) {
        if (!fs.existsSync(out)) {
            fs.writeFileSync(out, '', {mode: 0o755});
        }
        console.log(`${helper.name}: placeholder for ${target}`);
        continue;
    }
    const arch = target.startsWith('aarch64') ? 'arm64' : 'x86_64';
    execFileSync('xcrun', [
        'swiftc', '-O',
        '-target', `${arch}-apple-macos13.0`,
        path.join(tauri, helper.dir, 'main.swift'),
        '-o', out,
        // Its own Info.plist, so macOS can explain why it wants the microphone.
        ...(helper.plist ? ['-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(tauri, helper.dir, 'Info.plist')] : []),
    ], {stdio: 'inherit'});
    console.log(`${helper.name}: built ${path.relative(process.cwd(), out)}`);
}
