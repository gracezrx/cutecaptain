import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {fileURLToPath} from 'node:url';

import {defineConfig, devices} from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// End-to-end verification: boots the real Captain server (demo-mode model, so
// no provider keys are needed) serving the built web app, against a throwaway
// database, and drives it in a browser.
//
//   npm run e2e           run the suite
//   npm run e2e:ui        watch it in the Playwright UI
//
// Requires Postgres at E2E_DATABASE_URL (default: captain_e2e on localhost)
// and `npm run build` having produced dist/. Evidence (screenshots, traces)
// lands in e2e/evidence/ so a run leaves proof behind.

const PORT = Number(process.env.E2E_PORT ?? 8099);
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/captain_e2e';
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captain-e2e-files-'));

export default defineConfig({
    testDir: './e2e',
    outputDir: './e2e/evidence/runs',
    timeout: 60_000,
    expect: {timeout: 15_000},
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', {open: 'never', outputFolder: 'e2e/evidence/report'}]] : 'list',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off',
        ...(process.env.PLAYWRIGHT_CHROME ? {launchOptions: {executablePath: process.env.PLAYWRIGHT_CHROME}} : {}),
    },
    projects: [{name: 'chromium', use: {...devices['Desktop Chrome'], viewport: {width: 1280, height: 800}}}],
    webServer: {
        command: 'node scripts/reset-db.mjs && node --import tsx src/main.ts',
        cwd: path.resolve(HERE, '..', 'server'),
        url: `http://127.0.0.1:${PORT}/healthz`,
        timeout: 120_000,
        reuseExistingServer: false,
        env: {
            ...process.env,
            PORT: String(PORT),
            HOST: '127.0.0.1',
            PUBLIC_URL: `http://127.0.0.1:${PORT}`,
            DATABASE_URL: DB,
            FILES_DIR: filesDir,
            WEB_DIST: path.resolve(HERE, 'dist'),
            OPEN_SIGNUP: 'true',
            LLM_DEMO_FALLBACK: 'true',
            CAPTAIN_IGNORE_ENV_FILE: '1',
            LOG_LEVEL: process.env.E2E_SERVER_LOG ?? 'error',
        },
    },
});
