// The device's own stop before anything that leaves the computer or can't be
// undone: sending, posting, paying, booking, deleting. Shared by the Chrome
// extension (browser.ts) and the Mac app (computer.ts), so both stop at the
// same things whatever model is driving. The server turns a stop into an
// approval card; once approved it sends the same request again with
// `confirm` set to the target this module described, and the device acts
// only if what it sees now is still that target.

// Words on a button (or a key's effect) that send, post, pay or delete.
const OUTBOUND = [
    'send', 'send now', 'send email', 'send message', 'schedule send', 'post', 'publish', 'tweet', 'reply all and send', 'share',
    'submit', 'submit order', 'pay', 'pay now', 'buy', 'buy now', 'purchase', 'place order', 'place your order', 'order now', 'checkout', 'check out', 'complete purchase', 'complete order',
    'confirm', 'confirm payment', 'confirm order', 'confirm and pay', 'donate', 'transfer', 'withdraw', 'deposit',
    'delete', 'delete forever', 'delete all', 'remove', 'empty trash', 'discard', 'deactivate', 'close account', 'unsubscribe', 'cancel order', 'cancel subscription', 'cancel plan',
    'book', 'book now', 'reserve', 'accept', 'decline', 'rsvp', 'approve', 'invite', 'send invite', 'send invitation', 'send invitations', 'save and send',
];

// Buttons that look like those but only open something, go back, or search.
const HARMLESS = [
    'reply', 'reply all', 'forward', 'compose', 'new message', 'new email', 'save draft', 'search', 'next', 'previous', 'continue', 'back', 'cancel', 'close', 'edit',
    'open', 'view', 'show', 'more', 'sign in', 'log in', 'login', 'sign up with google', 'filter', 'sort', 'refresh', 'undo', 'copy', 'download', 'preview', 'attach', 'add',
    'remove filter', 'remove formatting', 'delete draft and close', 'share screen',
];

// Where sending is the job itself, not something that reaches people
// (a prompt to an AI assistant).
const ASSISTANT_SITES = ['chatgpt.com', 'chat.openai.com', 'gemini.google.com', 'claude.ai', 'www.perplexity.ai', 'perplexity.ai', 'copilot.microsoft.com'];

// Sites where "Save" sends something (calendar invitations).
const SAVE_SENDS = ['calendar.google.com', 'outlook.office.com', 'outlook.live.com'];

// Never worked on: money, passwords, account security.
export const BLOCKED_SITES = [
    /(^|\.)(chase|bankofamerica|wellsfargo|citi|capitalone|usbank|pnc|schwab|fidelity|vanguard|robinhood|etrade|ally|sofi|venmo|paypal|wise|revolut|coinbase|kraken|binance)\.com$/i,
    /(^|\.)(1password|lastpass|bitwarden|dashlane|keepersecurity)\.com$/i,
    /^myaccount\.google\.com$/i, /^accounts\.google\.com$/i, /^appleid\.apple\.com$/i, /^account\.microsoft\.com$/i, /^id\.apple\.com$/i,
    /^chromewebstore\.google\.com$/i, /^chrome\.google\.com$/i,
];

export function blockedSite(host: string): boolean {
    return BLOCKED_SITES.some((re) => re.test(host));
}

// "Send ‪(⌘Enter)‬" → "send"; "Delete forever" → "delete forever".
export function normalizeLabel(label: string): string {
    return label.
        replace(/[‪-‮‎‏]/g, '').
        replace(/\(.*?\)/g, ' ').
        replace(/[⌘⇧⌥⌃↵⏎]|ctrl|cmd/gi, ' ').
        replace(/[^\p{L}\p{N}\s]/gu, ' ').
        replace(/\s+/g, ' ').
        trim().
        toLowerCase();
}

// A button's label as a person would say it, for the approval card:
// "Send ‪(⌘Enter)‬" → "Send".
export function displayLabel(label: string): string {
    return label.replace(/[\u202a-\u202e\u200e\u200f]/g, '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || label.trim().slice(0, 60);
}

// Is pressing this (a button with this label, on this site) one of the
// things that must wait for the person?
export function isOutbound(label: string, site = ''): boolean {
    const l = normalizeLabel(label);
    if (!l || l.length > 60) {
        return false;
    }
    const host = site.toLowerCase();
    if (ASSISTANT_SITES.some((s) => host === s || host.endsWith(`.${s}`)) && /^(send|send message|send prompt|submit)$/.test(l)) {
        return false;
    }
    if (HARMLESS.includes(l)) {
        return false;
    }
    if (SAVE_SENDS.some((s) => host === s || host.endsWith(`.${s}`)) && /^save( and send)?$/.test(l)) {
        return true;
    }
    if (OUTBOUND.includes(l)) {
        return true;
    }
    // "Send to Leo", "Pay $42.00", "Delete 3 conversations", "Post reply".
    const first = l.split(' ')[0];
    return ['send', 'pay', 'buy', 'purchase', 'delete', 'publish', 'post', 'tweet', 'transfer', 'donate', 'checkout', 'unsubscribe', 'book'].includes(first);
}

// Keys that send in most apps when the cursor is in a message box.
export function isSendKey(combo: string): boolean {
    const c = combo.toLowerCase().replace(/\s+/g, '').replace('command', 'cmd').replace('control', 'ctrl').replace('return', 'enter');
    return ['cmd+enter', 'ctrl+enter', 'cmd+shift+d', 'meta+enter'].includes(c);
}

// The apps where Enter in the message box sends (the Mac's own chat apps).
export const ENTER_SENDS_APPS = ['Messages', 'Slack', 'WhatsApp', 'Telegram', 'Discord', 'Signal', 'Microsoft Teams', 'Teams', 'Zoom', 'Messenger', 'WeChat', 'LINE'];

// Labels of fields a model must never type into.
const SECRET_LABEL = /pass(word|code|phrase)|\bpin\b|one[- ]time|verification code|security code|2fa|two[- ]factor|\bcvc\b|\bcvv\b|card number|credit card|social security|\bssn\b/i;

export function isSecretField(f: {type?: string; autocomplete?: string; label?: string; subrole?: string}): boolean {
    const type = (f.type ?? '').toLowerCase();
    const ac = (f.autocomplete ?? '').toLowerCase();
    return type === 'password' ||
        f.subrole === 'AXSecureTextField' ||
        /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/.test(ac) ||
        SECRET_LABEL.test(f.label ?? '');
}

export const SECRET_REFUSAL = 'That\'s a password, code or card field. Captain never types those: only the person can. Ask them to do it (hand_over), then carry on.';

// What the device will check again before acting on a confirmation: the
// site, the button, and the gist of what it sends (so an approval for one
// email doesn't send a different one).
export function targetOf(site: string, label: string, details: {label: string; value: string}[]): string {
    const gist = details.map((d) => `${d.label}=${d.value.slice(0, 80)}`).join(';');
    return `${site}|${normalizeLabel(label)}|${hash(gist)}`;
}

// The details worth showing on an approval card, in a stable order.
export function cardDetails(fields: {label: string; value: string}[]): {label: string; value: string}[] {
    const seen = new Set<string>();
    const out: {label: string; value: string}[] = [];
    const rank = (l: string) => {
        const k = l.toLowerCase();
        return /^to\b|recipient/.test(k) ? 0 : /^cc/.test(k) ? 1 : /^bcc/.test(k) ? 2 : /subject|title/.test(k) ? 3 : /amount|total|price/.test(k) ? 4 : /date|when|time/.test(k) ? 5 : /guests?/.test(k) ? 6 : /body|message/.test(k) ? 8 : 7;
    };
    for (const f of [...fields].sort((a, b) => rank(a.label) - rank(b.label))) {
        const label = f.label.replace(/\s+/g, ' ').trim().slice(0, 40);
        const value = f.value.replace(/\s+/g, ' ').trim().slice(0, 300);
        if (label && value && !seen.has(label.toLowerCase())) {
            seen.add(label.toLowerCase());
            out.push({label, value});
        }
    }
    return out.slice(0, 6);
}

function hash(s: string): string {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}
