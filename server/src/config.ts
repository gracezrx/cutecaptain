// Server configuration, all from environment variables (see .env.example).

import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// When compiled, this file lives in dist/src; step back out of dist.
const SERVER_DIR = path.basename(ROOT) === 'dist' ? path.dirname(ROOT) : ROOT;

// A server/.env file, if present, fills in variables not already set.
const ENV_FILE = path.join(SERVER_DIR, '.env');
if (fs.existsSync(ENV_FILE) && process.env.CAPTAIN_IGNORE_ENV_FILE !== '1') {
    process.loadEnvFile(ENV_FILE);
}

function env(name: string, fallback = ''): string {
    return (process.env[name] ?? fallback).trim();
}

function int(name: string, fallback: number): number {
    const v = Number(env(name));
    return Number.isFinite(v) && env(name) !== '' ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
    const v = env(name).toLowerCase();
    return v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v);
}

function budget(v: string): number | null {
    if (/^(none|off|no|unlimited)$/i.test(v.trim())) {
        return null;
    }
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 20;
}

const production = env('NODE_ENV') === 'production';
const secret = env('APP_SECRET');
if (production && secret.length < 32) {
    throw new Error('Set APP_SECRET to a random string of at least 32 characters (it signs file links and protects saved model keys).');
}

// Without APP_SECRET outside production, keep a generated one in data/ so
// saved model keys and file links survive a restart.
function devSecret(): string {
    const file = path.join(SERVER_DIR, 'data', '.app-secret');
    try {
        const saved = fs.readFileSync(file, 'utf8').trim();
        if (saved.length >= 32) {
            return saved;
        }
    } catch {
        // not made yet
    }
    const value = randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, value, {mode: 0o600});
    } catch {
        // read-only disk: a fresh secret each start
    }
    return value;
}

export const config = {
    production,
    port: int('PORT', 8080),
    host: env('HOST', '0.0.0.0'),
    // The address people use to reach the server; used in invite links.
    publicUrl: env('PUBLIC_URL', `http://localhost:${int('PORT', 8080)}`).replace(/\/+$/, ''),
    databaseUrl: env('DATABASE_URL', 'postgres://postgres@127.0.0.1:5432/captain'),
    databasePoolSize: int('DATABASE_POOL_SIZE', 10),
    appSecret: secret || (production ? '' : devSecret()),
    // The monthly AI budget each new workspace starts with (USD). "none" for no limit.
    defaultWorkspaceBudgetUsd: budget(env('DEFAULT_WORKSPACE_BUDGET_USD', '20')),
    // Emails of people who run this server (set model keys) besides the first person to sign up.
    instanceAdmins: env('INSTANCE_ADMINS').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
    // Origins allowed to call the API from a browser (the Mac app's and the dev server's).
    corsOrigins: env('CORS_ORIGINS', 'tauri://localhost,http://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420').split(',').map((s) => s.trim()).filter(Boolean),
    // Anyone can sign up and create a workspace, or only people with an invite link.
    openSignup: bool('OPEN_SIGNUP', true),
    sessionDays: int('SESSION_DAYS', 30),
    files: {
        dir: env('FILES_DIR', path.join(SERVER_DIR, 'data', 'files')),
        maxBytes: int('MAX_UPLOAD_MB', 25) * 1024 * 1024,
        linkMinutes: int('FILE_LINK_MINUTES', 60 * 24),
    },
    // The built web app (desktop/dist), served at / so testers need no install.
    webDist: env('WEB_DIST', path.join(SERVER_DIR, '..', 'desktop', 'dist')),
    llm: {
        modelsFile: env('MODELS_FILE', path.join(SERVER_DIR, 'config', 'models.json')),
        // With no provider key configured, agents answer in demo mode.
        demoWhenUnconfigured: bool('LLM_DEMO_FALLBACK', true),
        requestTimeoutMs: int('LLM_TIMEOUT_MS', 120_000),
        // Ask a cheap model to rate difficulty when the heuristics are unsure.
        llmClassifier: bool('ROUTER_LLM_CLASSIFIER', false),
        // The longest answer a call may ask for. Without a cap, providers such as
        // OpenRouter set aside credit for the model's maximum (often 32k+ tokens)
        // and refuse the call when the balance can't cover it.
        maxOutputTokens: int('LLM_MAX_OUTPUT_TOKENS', 4000),
        // Model calls running at once per provider, per server. Several agents
        // working in parallel queue here instead of tripping rate limits.
        maxConcurrentPerProvider: int('LLM_MAX_CONCURRENT_PER_PROVIDER', 4),
    },
    agents: {
        maxParallelSteps: int('AGENT_MAX_PARALLEL', 3),
        maxSteps: int('AGENT_MAX_PLAN_STEPS', 6),
        maxToolRounds: int('AGENT_MAX_TOOL_ROUNDS', 6),
        // When an agent works on a person's screen or browser: each look, click
        // or keystroke is a round, so a real task takes dozens.
        maxComputerRounds: int('AGENT_MAX_COMPUTER_ROUNDS', 80),
        // Captain joining group chats unasked: how long it waits first, and how
        // long before it joins in the same chat again.
        joinInDelayMs: int('CAPTAIN_JOIN_IN_DELAY_MS', 4000),
        joinInCooldownMs: int('CAPTAIN_JOIN_IN_COOLDOWN_MS', 180_000),
    },
    workers: {
        enabled: bool('WORKERS', true),
        concurrency: int('WORKER_CONCURRENCY', 4),
        leaseSeconds: int('JOB_LEASE_SECONDS', 90),
    },
    connectors: {
        // Google apps through Composio (as in Captain's main web product). The
        // key can also be pasted in Settings → Connections by a server admin.
        composioKey: env('COMPOSIO_API_KEY'),
        composioBaseUrl: env('COMPOSIO_BASE_URL', 'https://backend.composio.dev/api/v3').replace(/\/+$/, ''),
        // MCP servers (Granola, Notion, Linear, your own): https on the public
        // internet only, unless this is on (a server you run on your own
        // network, or tests).
        mcpAllowPrivate: bool('MCP_ALLOW_PRIVATE', false),
    },
    tools: {
        tavilyKey: env('TAVILY_API_KEY'),
        braveKey: env('BRAVE_SEARCH_API_KEY'),
        // With neither, web search goes through OpenRouter (its web search) when
        // there's an OpenRouter key, so it works with nothing else to set up.
        // Ask a person before an agent opens a web page with data in its address
        // (?query, tokens) that nobody shared. Off: agents browse freely.
        askBeforeLinks: bool('AGENTS_ASK_BEFORE_LINKS', false),
        smtpUrl: env('SMTP_URL'), // e.g. smtps://user:pass@smtp.example.com:465
        mailFrom: env('MAIL_FROM'),
        emailDailyLimit: int('EMAIL_DAILY_LIMIT', 100), // recipients per workspace per day
    },
    // How many proxies sit in front of the server ("1" on Render, Fly, Railway or
    // behind one load balancer). Client IPs come from X-Forwarded-For only that far.
    trustProxy: (() => {
        const v = env('TRUST_PROXY', 'false').toLowerCase();
        if (v === 'false' || v === '0' || v === '') {
            return false;
        }
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : v.split(',').map((x) => x.trim());
    })() as false | number | string[],
    rateLimit: {
        perMinute: int('RATE_LIMIT_PER_MINUTE', 600),
        authPerMinute: int('AUTH_RATE_LIMIT_PER_MINUTE', 20),
    },
    logLevel: env('LOG_LEVEL', production ? 'info' : 'debug'),
    serverDir: SERVER_DIR,
};

export type Config = typeof config;
