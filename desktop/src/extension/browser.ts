// An agent's browser_* request, done in this Chrome (from the background
// worker). Agents work in Captain's own tabs, in a collapsed "Captain" group
// in the background, so the person keeps using theirs; Captain never
// navigates a tab it didn't open. Pages are read as a snapshot: every link,
// button and field gets an id like e12 that the agent clicks and types by.
// Reading and clicking run as scripts in the page; keys, pixel actions and
// pictures of background tabs go through Chrome's debugger when that
// permission is on.
//
// Before anything that sends, posts, pays, books or deletes, the extension
// stops and answers `needsConfirm` (lib/gate.ts); the server asks the person
// and, once approved, sends the request again with `confirm`. It never
// types into password, code or card fields, and never works on banking,
// payment or account-security sites.

import {blockedSite, cardDetails, displayLabel, isOutbound, isSecretField, isSendKey, SECRET_REFUSAL, targetOf} from '../lib/gate';
import type {DeviceResult} from '../lib/types';

export const BROWSER_CAPABILITIES = [
    'browser_tabs', 'browser_open', 'browser_switch', 'browser_snapshot', 'browser_read', 'browser_click', 'browser_type', 'browser_press', 'browser_select',
    'browser_scroll', 'browser_screenshot', 'browser_wait', 'browser_back', 'browser_close',
    'browser_input', // pixel actions, for the computer-use engine
    'confirm_gate', // stops before Send, Pay, Delete… and refuses password fields
];

const SNAPSHOT_CHARS = 14_000;
const READ_CHARS = 40_000;

// ------------------------------------------------------------ in the page
//
// These functions are serialized and run inside the page (an isolated world
// that stays between calls, so the ref map survives until the next snapshot).

type PageRefs = {n: number; map: Map<string, Element>};
declare global {
    interface Window { __captainRefs?: PageRefs }
}

function pageSnapshot(filter: string, maxChars: number): {title: string; url: string; text: string; count: number} {
    const refs: PageRefs = {n: 0, map: new Map()};
    window.__captainRefs = refs;
    const q = (filter || '').toLowerCase();
    const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="switch"], [role="searchbox"], [role="listbox"], [role="slider"], [contenteditable="true"], [contenteditable=""], [onclick], [tabindex]:not([tabindex="-1"])';
    const TEXTY = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TD', 'TH', 'DT', 'DD', 'LABEL', 'LEGEND', 'FIGCAPTION', 'BLOCKQUOTE', 'PRE', 'SUMMARY']);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 && r.height < 1) {
            return false;
        }
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    };
    const clean = (s: string | null | undefined, n = 80) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const labelFor = (el: Element): string => {
        const e = el as HTMLElement;
        const input = el as HTMLInputElement;
        const aria = clean(e.getAttribute('aria-label'));
        const labelled = e.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => clean(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
        const byFor = input.id ? clean(document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent) : '';
        const wrapping = clean(el.closest('label')?.textContent);
        return aria || labelled || byFor || clean(e.innerText || e.textContent) || clean(input.placeholder) || clean(e.title) || clean((el as HTMLImageElement).alt) || clean(input.name) || clean(e.getAttribute('data-tooltip')) || wrapping;
    };
    const role = (el: Element): string => {
        const r = el.getAttribute('role');
        if (r) {
            return r;
        }
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') {
            return 'link';
        }
        if (tag === 'input') {
            const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
            return ['button', 'submit', 'reset', 'image'].includes(t) ? 'button' : t === 'checkbox' || t === 'radio' ? t : `${t === 'text' ? '' : `${t} `}field`;
        }
        if (tag === 'textarea') {
            return 'textarea';
        }
        if (tag === 'select') {
            return 'select';
        }
        if ((el as HTMLElement).isContentEditable) {
            return 'editor';
        }
        return tag === 'button' || tag === 'summary' ? 'button' : 'clickable';
    };
    const valueOf = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'select') {
            const s = el as HTMLSelectElement;
            return clean(s.options[s.selectedIndex]?.text);
        }
        if (tag === 'input') {
            const i = el as HTMLInputElement;
            if (i.type === 'checkbox' || i.type === 'radio') {
                return i.checked ? 'checked' : 'unchecked';
            }
            return i.type === 'password' ? (i.value ? '••••' : '') : clean(i.value, 120);
        }
        if (tag === 'textarea') {
            return clean((el as HTMLTextAreaElement).value, 160);
        }
        if ((el as HTMLElement).isContentEditable) {
            return clean((el as HTMLElement).innerText, 160);
        }
        const checked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? el.getAttribute('aria-selected') ?? el.getAttribute('aria-expanded');
        return checked ? (checked === 'true' ? 'on' : 'off') : '';
    };

    const lines: string[] = [];
    let chars = 0;
    let count = 0;
    const seen = new Set<Element>();
    const push = (line: string) => {
        if (chars + line.length > maxChars) {
            return false;
        }
        lines.push(line);
        chars += line.length + 1;
        return true;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode as Element | null;
    let lastText = '';
    while (node) {
        const el = node as Element;
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG') {
            node = walker.nextSibling() as Element | null ?? skipOut(walker);
            continue;
        }
        if (el.matches(INTERACTIVE) && !seen.has(el) && visible(el)) {
            // A link wrapping a button, or a button's inner spans: one entry.
            const label = labelFor(el);
            const val = valueOf(el);
            const r = el.getBoundingClientRect();
            const where = r.bottom < 0 ? ' (above)' : r.top > vh ? ' (below)' : r.right < 0 || r.left > vw ? ' (off to the side)' : '';
            const text = `${label} ${val}`.toLowerCase();
            if (!q || text.includes(q)) {
                const id = `e${++refs.n}`;
                refs.map.set(id, el);
                count++;
                const href = tag === 'A' ? (el as HTMLAnchorElement).href : '';
                const extra = [val ? `= ${JSON.stringify(val)}` : '', (el as HTMLInputElement).disabled ? 'disabled' : '', href && !href.startsWith('javascript:') ? `→ ${href.slice(0, 100)}` : ''].filter(Boolean).join(' ');
                if (!push(`[${id}] ${role(el)} "${label}"${extra ? ` ${extra}` : ''}${where}`)) {
                    break;
                }
            }
            seen.add(el);
            el.querySelectorAll(INTERACTIVE).forEach((inner) => seen.add(inner));
            node = walker.nextSibling() as Element | null ?? skipOut(walker);
            continue;
        }
        if (!q && TEXTY.has(tag) && visible(el)) {
            const t = clean((el as HTMLElement).innerText, 300);
            if (t && t !== lastText) {
                lastText = t;
                const h = /^H[1-6]$/.test(tag) ? `${'#'.repeat(Number(tag[1]))} ` : '';
                if (!push(`${h}${t}`)) {
                    break;
                }
            }
            if (/^H[1-6]$/.test(tag) || tag === 'P' || tag === 'PRE' || tag === 'BLOCKQUOTE') {
                node = walker.nextSibling() as Element | null ?? skipOut(walker);
                continue;
            }
        }
        node = walker.nextNode() as Element | null;
    }
    function skipOut(w: TreeWalker): Element | null {
        // No next sibling: climb until there is one.
        while (w.parentNode()) {
            const s = w.nextSibling();
            if (s) {
                return s as Element;
            }
        }
        return null;
    }
    return {title: document.title, url: location.href, text: lines.join('\n'), count};
}

function pageRead(): {title: string; url: string; text: string} {
    const main = document.querySelector('article, main, [role=main]') as HTMLElement | null;
    const text = ((main ?? document.body)?.innerText ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return {title: document.title, url: location.href, text};
}

function pageFind(ref: string | null, text: string | null): {ok: boolean; error?: string; tag?: string; x?: number; y?: number} {
    let el: Element | null = null;
    if (ref) {
        el = window.__captainRefs?.map.get(ref) ?? null;
        if (!el || !el.isConnected) {
            return {ok: false, error: `There's no ${ref} on the page any more. Take a new browser_snapshot and use its ids.`};
        }
    } else if (text) {
        const want = text.replace(/\s+/g, ' ').trim().toLowerCase();
        const all = [...document.querySelectorAll('a, button, input, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], label, summary, li, span, div')];
        const label = (e: Element) => ((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const vis = (e: Element) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };
        el = all.find((e) => vis(e) && label(e) === want) ?? all.filter((e) => vis(e) && label(e).includes(want)).sort((a, b) => label(a).length - label(b).length)[0] ?? null;
        if (!el) {
            return {ok: false, error: `Nothing on the page says "${text}". Take a browser_snapshot and click by id.`};
        }
    } else {
        return {ok: false, error: 'Say which element: a ref from browser_snapshot, or its text.'};
    }
    (el as HTMLElement).scrollIntoView({block: 'center', inline: 'center'});
    const r = el.getBoundingClientRect();
    window.__captainLast = el;
    return {ok: true, tag: el.tagName.toLowerCase(), x: r.left + r.width / 2, y: r.top + r.height / 2};
}
declare global {
    interface Window { __captainLast?: Element }
}

// A click as a page sees it: pointer, mouse and click events on the element
// under the point, so frameworks that listen for mousedown react too.
function pageClick(): {ok: boolean; error?: string} {
    const el = window.__captainLast as HTMLElement | undefined;
    if (!el) {
        return {ok: false, error: 'Nothing to click.'};
    }
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const target = (document.elementFromPoint(x, y) as HTMLElement | null) ?? el;
    const opts = {bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window};
    target.dispatchEvent(new PointerEvent('pointerdown', {...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true}));
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    if (typeof (el as HTMLElement).focus === 'function') {
        el.focus({preventScroll: true});
    }
    target.dispatchEvent(new PointerEvent('pointerup', {...opts, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true}));
    target.dispatchEvent(new MouseEvent('mouseup', {...opts, buttons: 0}));
    target.dispatchEvent(new MouseEvent('click', {...opts, buttons: 0}));
    return {ok: true};
}

// Put text in the focused field (ref or wherever the cursor is), replacing
// or appending. execCommand types like a person would, in editors too.
function pageType(ref: string | null, text: string, append: boolean): {ok: boolean; error?: string; inForm?: boolean; via: string} {
    let el: HTMLElement | null = null;
    if (ref) {
        el = (window.__captainRefs?.map.get(ref) as HTMLElement | undefined) ?? null;
        if (!el || !el.isConnected) {
            return {ok: false, error: `There's no ${ref} on the page any more. Take a new browser_snapshot.`, via: ''};
        }
        el.scrollIntoView({block: 'center'});
        el.focus({preventScroll: true});
        el.click?.();
    }
    const active = (ref ? el : document.activeElement) as HTMLElement | null;
    if (!active || active === document.body) {
        return {ok: false, error: 'No field has the cursor. Click a field first, or give its ref.', via: ''};
    }
    const input = active as HTMLInputElement | HTMLTextAreaElement;
    const isField = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA';
    const editable = active.isContentEditable;
    if (!isField && !editable) {
        // A wrapper around the real editor (common in web apps): the editable inside it.
        const inner = active.querySelector('[contenteditable="true"], textarea, input') as HTMLElement | null;
        if (inner) {
            inner.focus({preventScroll: true});
            return pageType(null, text, append);
        }
        return {ok: false, error: `${ref ?? 'That element'} isn't something you can type into. Click into the field first.`, via: ''};
    }
    if (!append) {
        if (isField) {
            input.select();
        } else {
            document.execCommand('selectAll', false);
        }
    } else if (isField) {
        const end = input.value.length;
        input.setSelectionRange?.(end, end);
    }
    let via = 'execCommand';
    let ok = false;
    try {
        ok = document.execCommand('insertText', false, text);
    } catch {
        ok = false;
    }
    if (!ok && isField) {
        // Frameworks that watch the native setter (React): set it that way and tell them.
        const proto = active.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        const next = append ? input.value + text : text;
        if (setter) {
            setter.call(input, next);
        } else {
            input.value = next;
        }
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
        via = 'value';
        ok = true;
    }
    if (!ok && editable) {
        if (!append) {
            active.textContent = '';
        }
        active.appendChild(document.createTextNode(text));
        active.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
        via = 'text';
        ok = true;
    }
    return {ok, inForm: Boolean(active.closest('form')), via};
}

// Keys as DOM events (when the debugger isn't available): what most web
// apps listen for. Enter in a form field submits the form.
function pagePress(key: string, mods: string[]): {ok: boolean; note?: string} {
    const active = (document.activeElement as HTMLElement | null) ?? document.body;
    const init: KeyboardEventInit = {
        key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true,
        metaKey: mods.includes('cmd'), ctrlKey: mods.includes('ctrl'), shiftKey: mods.includes('shift'), altKey: mods.includes('alt'),
    };
    const down = active.dispatchEvent(new KeyboardEvent('keydown', init));
    active.dispatchEvent(new KeyboardEvent('keypress', init));
    active.dispatchEvent(new KeyboardEvent('keyup', init));
    if (key === 'Enter' && down && !mods.length) {
        const form = active.closest('form');
        if (form && active.tagName !== 'TEXTAREA') {
            form.requestSubmit();
            return {ok: true, note: 'submitted the form'};
        }
    }
    return {ok: true};
}

function pageSelect(ref: string, value: string): {ok: boolean; error?: string; chosen?: string} {
    const el = window.__captainRefs?.map.get(ref) as HTMLSelectElement | undefined;
    if (!el || el.tagName !== 'SELECT') {
        return {ok: false, error: `${ref} isn't a dropdown (a <select>). For custom menus, click it and then click the option.`};
    }
    const want = value.trim().toLowerCase();
    const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) ?? [...el.options].find((o) => o.text.toLowerCase().includes(want));
    if (!opt) {
        return {ok: false, error: `No option "${value}". The options are: ${[...el.options].map((o) => o.text.trim()).slice(0, 40).join(', ')}.`};
    }
    el.value = opt.value;
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    return {ok: true, chosen: opt.text.trim()};
}

function pageScroll(direction: string, ref: string | null): {ok: boolean; error?: string} {
    const target = ref ? (window.__captainRefs?.map.get(ref) as HTMLElement | undefined) : undefined;
    if (ref && !target) {
        return {ok: false, error: `There's no ${ref} on the page. Take a new browser_snapshot.`};
    }
    const scroller = target ?? document.scrollingElement ?? document.body;
    const h = target ? target.clientHeight : window.innerHeight;
    const top = direction === 'top' ? 0 : direction === 'bottom' ? scroller.scrollHeight : scroller.scrollTop + (direction === 'up' ? -h * 0.8 : h * 0.8);
    if (target) {
        target.scrollTo({top, behavior: 'instant' as ScrollBehavior});
    } else {
        window.scrollTo({top, behavior: 'instant' as ScrollBehavior});
    }
    return {ok: true};
}

function pageHasText(text: string): boolean {
    return (document.body?.innerText ?? '').toLowerCase().includes(text.toLowerCase());
}

// What an action is about to touch, for the gate (lib/gate.ts) in the
// worker: the element's label and role, whether it's a secret field, the
// visible fields around it (To, Subject, the body…), and for a key press in
// a message box, the label of the button that key would press.
type Described = {
    label: string;
    role: string;
    secret: {type: string; autocomplete: string; label: string} | null;
    details: {label: string; value: string}[];
    sendLabel: string;
    editable: boolean;
};

function pageDescribe(mode: string, ref: string | null, x: number, y: number): Described | null {
    const clean = (s: string | null | undefined, n = 80) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const labelOf = (e: Element): string => {
        const h = e as HTMLElement;
        const i = e as HTMLInputElement;
        const labelled = h.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => clean(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
        const byFor = i.id ? clean(document.querySelector(`label[for="${CSS.escape(i.id)}"]`)?.textContent) : '';
        return clean(h.getAttribute('aria-label')) || labelled || byFor || clean(h.getAttribute('data-tooltip')) || clean(h.title) ||
            (i.tagName === 'INPUT' && ['submit', 'button'].includes(i.type) ? clean(i.value) : '') || clean(h.innerText || h.textContent) || clean(i.placeholder) || clean(i.name);
    };
    const visible = (e: Element) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    };
    let el: Element | null = null;
    if (mode === 'ref' && ref) {
        el = window.__captainRefs?.map.get(ref) ?? null;
    } else if (mode === 'last') {
        el = window.__captainLast ?? null;
    } else if (mode === 'point') {
        el = document.elementFromPoint(x, y);
    } else {
        el = document.activeElement;
        // Inside an iframe on the same page: follow the focus in.
        while (el && el.tagName === 'IFRAME') {
            try {
                el = (el as HTMLIFrameElement).contentDocument?.activeElement ?? el;
                if (el?.tagName === 'IFRAME') {
                    break;
                }
            } catch {
                break;
            }
        }
    }
    if (!el) {
        return null;
    }
    const clickable = mode === 'active' ? el : el.closest('button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], input[type="submit"], input[type="button"], summary') ?? el;
    const field = el as HTMLInputElement;
    const isInput = field.tagName === 'INPUT' || field.tagName === 'TEXTAREA';
    const editable = isInput || (el as HTMLElement).isContentEditable;
    const secret = isInput || (el as HTMLElement).isContentEditable ?
        {type: field.type ?? '', autocomplete: field.getAttribute('autocomplete') ?? '', label: labelOf(el)} :
        null;

    // The fields around it: the form, the dialog (a compose window), or the region.
    const box = clickable.closest('form, [role="dialog"], [role="region"], [role="main"], dialog') ?? document.body;
    const details: {label: string; value: string}[] = [];
    const emails = [...new Set([...box.querySelectorAll('[email]')].map((e) => e.getAttribute('email') ?? '').filter((v) => v.includes('@')))];
    if (emails.length) {
        details.push({label: 'To', value: emails.join(', ')});
    }
    for (const f of [...box.querySelectorAll('input, textarea, select, [contenteditable="true"], [contenteditable=""]')].slice(0, 60)) {
        const i = f as HTMLInputElement;
        if (!visible(f) || ['hidden', 'password', 'checkbox', 'radio', 'submit', 'button', 'file', 'image', 'reset'].includes((i.type ?? '').toLowerCase())) {
            continue;
        }
        const value = f.tagName === 'SELECT' ? clean((f as HTMLSelectElement).selectedOptions[0]?.text, 300) : clean(i.value ?? (f as HTMLElement).innerText, 300) || clean((f as HTMLElement).innerText, 300);
        const label = labelOf(f).replace(/\s*recipients?$/i, '') || 'Field';
        if (value && !/^(search|search mail|search in mail)$/i.test(label)) {
            details.push({label, value});
        }
        if (details.length >= 8) {
            break;
        }
    }

    // A key press in a field: what would it press? The form's submit button,
    // or a Send/Post button next to a message box.
    let sendLabel = '';
    if (mode === 'active' && editable) {
        const form = el.closest('form');
        if (form && field.tagName !== 'TEXTAREA' && !(el as HTMLElement).isContentEditable) {
            const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
            sendLabel = submit ? labelOf(submit) : '';
        } else {
            let up: Element | null = el.parentElement;
            for (let i = 0; up && i < 8 && !sendLabel; i++, up = up.parentElement) {
                const b = [...up.querySelectorAll('button, [role="button"], input[type="submit"]')].find((c) => visible(c) && /\b(send|post|reply|submit|comment|tweet|share)\b/i.test(labelOf(c)));
                sendLabel = b ? labelOf(b) : '';
            }
        }
    }
    return {label: labelOf(clickable), role: clickable.getAttribute('role') ?? clickable.tagName.toLowerCase(), secret, details, sendLabel, editable};
}

// The page's size in CSS pixels (what screenshots and pixel actions use).
function pageViewport(): {width: number; height: number; dpr: number; url: string; title: string} {
    return {width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1, url: location.href, title: document.title};
}

// ------------------------------------------------------------ in the worker

class BrowserError extends Error {}

async function run<T>(tabId: number, func: (...a: never[]) => T, args: unknown[] = []): Promise<T> {
    let results: {result?: unknown}[];
    try {
        results = await chrome.scripting.executeScript({target: {tabId}, func: func as unknown as () => unknown, args} as chrome.scripting.ScriptInjection<unknown[], unknown>);
    } catch (e) {
        const m = String((e as Error)?.message ?? e);
        if (/chrome:\/\/|chrome-extension|webstore|cannot be scripted|Cannot access|Extension manifest must request permission/i.test(m)) {
            throw new BrowserError('Chrome doesn\'t let extensions work on this page (a Chrome page, the Web Store, or a site without permission). Open a normal web page.');
        }
        throw new BrowserError(m);
    }
    if (!results?.[0] || !('result' in results[0])) {
        throw new BrowserError('The page gave no answer.');
    }
    return results[0].result as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([p, sleep(ms).then(() => null)]);
}

function hostOf(url: string | undefined): string {
    try {
        return new URL(url ?? '').hostname;
    } catch {
        return '';
    }
}

const SITE_NAMES: Record<string, string> = {
    'mail.google.com': 'Gmail', 'calendar.google.com': 'Google Calendar', 'docs.google.com': 'Google Docs', 'drive.google.com': 'Google Drive',
    'outlook.office.com': 'Outlook', 'outlook.live.com': 'Outlook', 'app.slack.com': 'Slack', 'www.notion.so': 'Notion', 'chatgpt.com': 'ChatGPT',
    'x.com': 'X', 'www.linkedin.com': 'LinkedIn',
};

function siteName(host: string): string {
    return SITE_NAMES[host] ?? host.replace(/^www\./, '');
}

// ---- Captain's tabs
//
// Agents work in tabs Captain opened, in a collapsed "Captain" group, never
// made active: the person keeps using their own tabs. Captain never
// navigates a tab it didn't open. Kept in session storage so a worker that
// Chrome put to sleep still knows its tabs.

let workingTab: number | null = null;
const opened = new Set<number>();
let groupId: number | null = null;
let loaded = false;

async function load(): Promise<void> {
    if (loaded) {
        return;
    }
    loaded = true;
    const s = await chrome.storage.session.get('captain.tabs').catch(() => ({} as Record<string, unknown>));
    const saved = s['captain.tabs'] as {working: number | null; opened: number[]; group: number | null} | undefined;
    if (saved) {
        workingTab = saved.working;
        saved.opened.forEach((id) => opened.add(id));
        groupId = saved.group;
    }
}

function save(): void {
    void chrome.storage.session.set({'captain.tabs': {working: workingTab, opened: [...opened], group: groupId}}).catch(() => undefined);
}

chrome.tabs.onRemoved.addListener((id) => {
    attached.delete(id);
    if (opened.delete(id) || workingTab === id) {
        if (workingTab === id) {
            workingTab = null;
        }
        save();
    }
});

async function tabById(id: number): Promise<chrome.tabs.Tab> {
    try {
        return await chrome.tabs.get(id);
    } catch {
        throw new BrowserError(`There's no tab ${id} any more. Use browser_tabs.`);
    }
}

// The tab to work in: the one named, the one in use, or (for reading "the
// page I have open") the person's active tab.
async function currentTab(args: Record<string, unknown>): Promise<chrome.tabs.Tab> {
    const wanted = typeof args.tabId === 'number' ? args.tabId : workingTab;
    if (wanted !== null) {
        try {
            const t = await chrome.tabs.get(wanted);
            if (workingTab !== t.id) {
                workingTab = t.id ?? null;
                save();
            }
            return t;
        } catch {
            workingTab = null;
        }
    }
    const [active] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    const tab = active ?? (await chrome.tabs.query({active: true}))[0];
    if (!tab?.id) {
        throw new BrowserError('Chrome has no open tab. Use browser_open.');
    }
    workingTab = tab.id;
    save();
    return tab;
}

async function intoGroup(tab: chrome.tabs.Tab): Promise<void> {
    if (!tab.id || !chrome.tabGroups) {
        return;
    }
    try {
        if (groupId !== null) {
            const g = await chrome.tabGroups.get(groupId).catch(() => null);
            if (!g || g.windowId !== tab.windowId) {
                groupId = null;
            }
        }
        groupId = await chrome.tabs.group(groupId !== null ? {tabIds: [tab.id], groupId} : {tabIds: [tab.id], createProperties: {windowId: tab.windowId}});
        await chrome.tabGroups.update(groupId, {title: 'Captain', color: 'blue', collapsed: true});
    } catch {
        // tab groups unavailable (an old Chrome, a popup window): an ordinary background tab is fine
    }
}

// A new Captain tab, in the background, in the window the person last used.
async function captainTab(url: string): Promise<chrome.tabs.Tab> {
    const win = await chrome.windows.getLastFocused({windowTypes: ['normal']}).catch(() => null);
    const tab = await chrome.tabs.create({url, active: false, ...(win?.id ? {windowId: win.id} : {})});
    opened.add(tab.id!);
    workingTab = tab.id!;
    save();
    await intoGroup(tab);
    return tab;
}

function waitLoaded(tabId: number, timeoutMs = 20_000): Promise<void> {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (!done) {
                done = true;
                chrome.tabs.onUpdated.removeListener(onUpdate);
                clearTimeout(timer);
                resolve();
            }
        };
        const onUpdate = (id: number, info: {status?: string}) => {
            if (id === tabId && info.status === 'complete') {
                finish();
            }
        };
        chrome.tabs.onUpdated.addListener(onUpdate);
        const timer = setTimeout(finish, timeoutMs);
        void chrome.tabs.get(tabId).then((t) => t.status === 'complete' && setTimeout(finish, 300)).catch(finish);
    });
}

async function settle(tabId: number, ms = 500): Promise<chrome.tabs.Tab> {
    await sleep(ms);
    const now = await tabById(tabId);
    if (now.status === 'loading') {
        await waitLoaded(tabId, 10_000);
    }
    return tabById(tabId);
}

async function snapshot(tab: chrome.tabs.Tab, filter = ''): Promise<string> {
    const s = await run(tab.id!, pageSnapshot, [filter, SNAPSHOT_CHARS]);
    const where = opened.has(tab.id!) ? ' (Captain\'s tab, in the background)' : tab.active ? ' (the person\'s own tab, in front)' : '';
    const head = `${s.title || '(untitled)'} — ${s.url}${where}\n${s.count} elements with ids${filter ? ` matching "${filter}"` : ''}. Ids are good until the next snapshot or page change.`;
    return `${head}\n\n${s.text || '(nothing readable; the page may still be loading — browser_wait, then snapshot again)'}`;
}

function notBlocked(tab: chrome.tabs.Tab | {url?: string}): void {
    const host = hostOf(tab.url);
    if (host && blockedSite(host)) {
        throw new BrowserError(`Captain doesn't work on ${host} (banking, payments, passwords and account security stay with the person). Ask them to do this part.`);
    }
}

// ---- Chrome's debugger: real key presses, pixel clicks and pictures of
// background tabs. One session per tab, kept until the run ends (attaching
// for every key makes Chrome's "started debugging" bar flicker).

const attached = new Set<number>();
let debuggerAllowed: boolean | null = null;

async function canDebug(): Promise<boolean> {
    if (debuggerAllowed === null) {
        debuggerAllowed = await chrome.permissions.contains({permissions: ['debugger']}).catch(() => false);
    }
    return debuggerAllowed;
}

chrome.permissions?.onAdded?.addListener(() => {
    debuggerAllowed = null;
});
chrome.debugger?.onDetach?.addListener((source) => {
    if (source.tabId) {
        attached.delete(source.tabId);
    }
});

async function cdp<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
    if (!attached.has(tabId)) {
        await chrome.debugger.attach({tabId}, '1.3');
        attached.add(tabId);
        // Keep a background tab behaving as if it were in front (focus events, timers).
        await chrome.debugger.sendCommand({tabId}, 'Emulation.setFocusEmulationEnabled', {enabled: true}).catch(() => undefined);
    }
    return (await chrome.debugger.sendCommand({tabId}, method, params)) as T;
}

const KEY_CODES: Record<string, {code: string; vk: number; text?: string}> = {
    Enter: {code: 'Enter', vk: 13, text: '\r'}, Tab: {code: 'Tab', vk: 9}, Escape: {code: 'Escape', vk: 27}, Backspace: {code: 'Backspace', vk: 8}, Delete: {code: 'Delete', vk: 46},
    ArrowUp: {code: 'ArrowUp', vk: 38}, ArrowDown: {code: 'ArrowDown', vk: 40}, ArrowLeft: {code: 'ArrowLeft', vk: 37}, ArrowRight: {code: 'ArrowRight', vk: 39},
    Home: {code: 'Home', vk: 36}, End: {code: 'End', vk: 35}, PageUp: {code: 'PageUp', vk: 33}, PageDown: {code: 'PageDown', vk: 34}, ' ': {code: 'Space', vk: 32, text: ' '},
};
const ALIASES: Record<string, string> = {enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', space: ' '};
const MODS: Record<string, string> = {command: 'cmd', meta: 'cmd', cmd: 'cmd', super: 'cmd', win: 'cmd', control: 'ctrl', ctrl: 'ctrl', option: 'alt', opt: 'alt', alt: 'alt', shift: 'shift'};

function parseKey(combo: string): {key: string; mods: string[]} {
    const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
    const last = parts.pop() ?? '';
    const mods = parts.map((m) => MODS[m.toLowerCase()] ?? m.toLowerCase());
    const key = ALIASES[last.toLowerCase()] ?? last;
    return {key, mods};
}

function modifierBits(mods: string[]): number {
    return (mods.includes('alt') ? 1 : 0) | (mods.includes('ctrl') ? 2 : 0) | (mods.includes('cmd') ? 4 : 0) | (mods.includes('shift') ? 8 : 0);
}

async function debugPress(tabId: number, key: string, mods: string[]): Promise<void> {
    const modifiers = modifierBits(mods);
    const special = KEY_CODES[key];
    const base = special ? {key, code: special.code, windowsVirtualKeyCode: special.vk, nativeVirtualKeyCode: special.vk} : {key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0};
    const text = special?.text ?? (key.length === 1 && !mods.includes('cmd') && !mods.includes('ctrl') ? key : undefined);
    // cmd+a, cmd+c, cmd+v… as editing commands: the page sees the key and the edit happens.
    const commands = mods.includes('cmd') || mods.includes('ctrl') ? ({a: ['selectAll'], c: ['copy'], v: ['paste'], x: ['cut'], z: [mods.includes('shift') ? 'redo' : 'undo']} as Record<string, string[]>)[key.toLowerCase()] : undefined;
    await cdp(tabId, 'Input.dispatchKeyEvent', {type: text ? 'keyDown' : 'rawKeyDown', modifiers, ...base, ...(text ? {text, unmodifiedText: text} : {}), ...(commands ? {commands} : {})});
    await cdp(tabId, 'Input.dispatchKeyEvent', {type: 'keyUp', modifiers, ...base});
}

async function press(tab: chrome.tabs.Tab, combo: string): Promise<string> {
    const {key, mods} = parseKey(combo);
    if (await canDebug()) {
        try {
            await debugPress(tab.id!, key, mods);
            return `Pressed ${combo}.`;
        } catch {
            // a page the debugger can't attach to (DevTools open on it…): the DOM way
        }
    }
    const r = await run(tab.id!, pagePress, [key, mods]);
    return `Pressed ${combo}${r.note ? ` (${r.note})` : ''}.`;
}

// A picture of the tab, even in the background, at `width` pixels wide
// (the page's own size when 0): through the debugger, which Chrome may
// refuse for a tab it isn't painting, so it's best-effort and quick.
async function picture(tab: chrome.tabs.Tab, opts: {width?: number; jpeg?: boolean; timeoutMs?: number} = {}): Promise<string | null> {
    if (await canDebug()) {
        try {
            const vp = await run(tab.id!, pageViewport);
            const target = opts.width || vp.width;
            const shot = await withTimeout(cdp<{data: string}>(tab.id!, 'Page.captureScreenshot', {
                format: opts.jpeg ? 'jpeg' : 'png', ...(opts.jpeg ? {quality: 55} : {}), fromSurface: true, captureBeyondViewport: false,
                clip: {x: 0, y: 0, width: vp.width, height: vp.height, scale: target / (vp.width * vp.dpr)},
            }), opts.timeoutMs ?? 2500);
            if (shot?.data) {
                return `data:image/${opts.jpeg ? 'jpeg' : 'png'};base64,${shot.data}`;
            }
        } catch {
            // fall through
        }
    }
    if (tab.active && !opts.jpeg) {
        const win = await chrome.windows.get(tab.windowId).catch(() => null);
        if (win?.focused) {
            return chrome.tabs.captureVisibleTab(tab.windowId, {format: 'png'}).catch(() => null);
        }
    }
    return null;
}

// ---- the gate (lib/gate.ts): stop before sending, paying, posting, deleting

type Gate = {kind: 'click'; described: Described | null} | {kind: 'key'; described: Described | null; combo: string};

function gateCheck(tab: chrome.tabs.Tab, g: Gate, confirm: unknown): DeviceResult | null {
    const d = g.described;
    if (!d) {
        return null;
    }
    const host = hostOf(tab.url);
    let label = '';
    if (g.kind === 'click') {
        label = isOutbound(d.label, host) ? d.label : '';
    } else {
        const {key, mods} = parseKey(g.combo);
        if (isSendKey(g.combo) && d.editable) {
            label = d.sendLabel && !isOutbound(d.sendLabel, host) ? '' : d.sendLabel || 'Send';
            if (!d.sendLabel && /^(chatgpt\.com|chat\.openai\.com|gemini\.google\.com|claude\.ai)$/.test(host)) {
                label = '';
            }
        } else if (key === 'Enter' && !mods.length && d.editable && d.sendLabel && isOutbound(d.sendLabel, host)) {
            label = d.sendLabel;
        }
    }
    if (!label) {
        return null;
    }
    const details = cardDetails(d.details);
    const target = targetOf(host, label, details);
    if (confirm === target) {
        return null;
    }
    const action = g.kind === 'click' ? `Click "${displayLabel(label)}"` : `Press ${g.combo} (${displayLabel(label)})`;
    return {needsConfirm: {action, target, site: siteName(host), details: confirm ? [{label: 'Note', value: 'This changed after you approved it, so here it is again.'}, ...details].slice(0, 8) : details}};
}

function secretCheck(d: Described | null): DeviceResult | null {
    return d?.secret && isSecretField(d.secret) ? {needsPerson: SECRET_REFUSAL} : null;
}

// ---- pixel actions (the computer-use engine on the server drives these)

type PixelAction = {type: string; x?: number; y?: number; button?: string; keys?: string[]; path?: {x: number; y: number}[]; scroll_x?: number; scroll_y?: number; text?: string};

const BUTTONS: Record<string, string> = {left: 'left', right: 'right', middle: 'middle', wheel: 'middle', back: 'back', forward: 'forward'};

function cuaCombo(keys: string[]): string {
    const map: Record<string, string> = {CTRL: 'ctrl', CONTROL: 'ctrl', CMD: 'cmd', META: 'cmd', COMMAND: 'cmd', SUPER: 'cmd', ALT: 'alt', OPTION: 'alt', SHIFT: 'shift', ENTER: 'Enter', RETURN: 'Enter', ESC: 'Escape', ESCAPE: 'Escape', TAB: 'Tab', BACKSPACE: 'Backspace', DELETE: 'Delete', SPACE: 'space', UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', ARROWUP: 'ArrowUp', ARROWDOWN: 'ArrowDown', ARROWLEFT: 'ArrowLeft', ARROWRIGHT: 'ArrowRight', PAGEUP: 'PageUp', PAGEDOWN: 'PageDown', HOME: 'Home', END: 'End'};
    return keys.map((k) => map[k.toUpperCase()] ?? (k.length === 1 ? k.toLowerCase() : k)).join('+');
}

async function mouse(tabId: number, type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
    await cdp(tabId, 'Input.dispatchMouseEvent', {type, x, y, ...extra});
}

async function pixel(tab: chrome.tabs.Tab, a: PixelAction, confirm: unknown): Promise<DeviceResult> {
    if (!(await canDebug())) {
        throw new BrowserError('Pixel actions need the debugger permission: in the Captain popup, turn "Let agents use this Chrome" off and on again.');
    }
    const id = tab.id!;
    const x = Math.round(Number(a.x) || 0);
    const y = Math.round(Number(a.y) || 0);
    const mods = (a.keys ?? []).map((k) => MODS[k.toLowerCase()] ?? '').filter(Boolean);
    const modifiers = modifierBits(mods);
    switch (a.type) {
    case 'screenshot': {
        const img = await picture(tab, {timeoutMs: 4000});
        if (!img) {
            throw new BrowserError('Chrome isn\'t drawing this background tab, so there\'s no picture of it. Work from browser_snapshot, or ask the person to press Show me.');
        }
        return {text: 'The tab now.', images: [img]};
    }
    case 'click':
    case 'double_click': {
        const blocked = gateCheck(tab, {kind: 'click', described: await run(id, pageDescribe, ['point', null, x, y]).catch(() => null)}, confirm);
        if (blocked) {
            return blocked;
        }
        const button = BUTTONS[a.button ?? 'left'] ?? 'left';
        const count = a.type === 'double_click' ? 2 : 1;
        await mouse(id, 'mouseMoved', x, y, {modifiers});
        for (let i = 1; i <= count; i++) {
            await mouse(id, 'mousePressed', x, y, {button, clickCount: i, modifiers});
            await mouse(id, 'mouseReleased', x, y, {button, clickCount: i, modifiers});
        }
        await settle(id, 400);
        return {text: `${count === 2 ? 'Double-clicked' : 'Clicked'} (${x}, ${y}).`};
    }
    case 'move':
        await mouse(id, 'mouseMoved', x, y, {modifiers});
        return {text: `Moved to (${x}, ${y}).`};
    case 'drag': {
        const path = (a.path ?? []).map((p) => ({x: Math.round(p.x), y: Math.round(p.y)}));
        if (path.length < 2) {
            throw new BrowserError('A drag needs at least two points.');
        }
        await mouse(id, 'mouseMoved', path[0].x, path[0].y, {modifiers});
        await mouse(id, 'mousePressed', path[0].x, path[0].y, {button: 'left', clickCount: 1, modifiers});
        for (const p of path.slice(1)) {
            await mouse(id, 'mouseMoved', p.x, p.y, {button: 'left', buttons: 1, modifiers});
        }
        const end = path[path.length - 1];
        await mouse(id, 'mouseReleased', end.x, end.y, {button: 'left', clickCount: 1, modifiers});
        return {text: `Dragged to (${end.x}, ${end.y}).`};
    }
    case 'scroll':
        await mouse(id, 'mouseWheel', x, y, {deltaX: Number(a.scroll_x) || 0, deltaY: Number(a.scroll_y) || 0, modifiers});
        await sleep(250);
        return {text: 'Scrolled.'};
    case 'keypress': {
        const combo = cuaCombo(a.keys ?? []);
        const d = await run(id, pageDescribe, ['active', null, 0, 0]).catch(() => null);
        if (/v$/i.test(combo) && /(cmd|ctrl)\+/.test(combo)) {
            const secret = secretCheck(d);
            if (secret) {
                return secret;
            }
        }
        const blocked = gateCheck(tab, {kind: 'key', described: d, combo}, confirm);
        if (blocked) {
            return blocked;
        }
        const {key, mods: m} = parseKey(combo);
        await debugPress(id, key, m);
        await settle(id, 300);
        return {text: `Pressed ${combo}.`};
    }
    case 'type': {
        const secret = secretCheck(await run(id, pageDescribe, ['active', null, 0, 0]).catch(() => null));
        if (secret) {
            return secret;
        }
        await cdp(id, 'Input.insertText', {text: String(a.text ?? '')});
        return {text: `Typed ${String(a.text ?? '').length} characters.`};
    }
    case 'wait':
        await sleep(1500);
        return {text: 'Waited.'};
    default:
        throw new BrowserError(`Unknown action ${a.type}.`);
    }
}

// ---- for the background worker

// "Show me": the tab an agent is working in, in front.
export async function showWorkingTab(): Promise<void> {
    await load();
    if (workingTab === null) {
        return;
    }
    const tab = await chrome.tabs.get(workingTab).catch(() => null);
    if (!tab?.id) {
        return;
    }
    if (chrome.tabGroups && tab.groupId !== undefined && tab.groupId >= 0) {
        await chrome.tabGroups.update(tab.groupId, {collapsed: false}).catch(() => undefined);
    }
    await chrome.tabs.update(tab.id, {active: true}).catch(() => undefined);
    await chrome.windows.update(tab.windowId, {focused: true}).catch(() => undefined);
}

// The run ended: let go of the debugger (its bar goes away) and fold the
// group away. The tabs stay, in case the person wants to look.
export async function releaseWork(): Promise<void> {
    for (const tabId of [...attached]) {
        await chrome.debugger.detach({tabId}).catch(() => undefined);
        attached.delete(tabId);
    }
    if (groupId !== null && chrome.tabGroups) {
        await chrome.tabGroups.update(groupId, {collapsed: true}).catch(() => undefined);
    }
}

// What the little Captain shows while it works: the site and a small picture.
export async function workingView(withPicture: boolean): Promise<{site?: string; thumb?: string}> {
    if (workingTab === null) {
        return {};
    }
    const tab = await chrome.tabs.get(workingTab).catch(() => null);
    if (!tab) {
        return {};
    }
    const site = siteName(hostOf(tab.url));
    const thumb = withPicture ? await picture(tab, {width: 320, jpeg: true, timeoutMs: 1200}).catch(() => null) : null;
    return {site, ...(thumb ? {thumb} : {})};
}

// ------------------------------------------------------------ requests

export async function runBrowser(tool: string, a: Record<string, unknown>): Promise<DeviceResult> {
    await load();
    const s = (v: unknown) => String(v ?? '');
    switch (tool) {
    case 'browser_tabs': {
        const tabs = await chrome.tabs.query({});
        const lines = tabs.filter((t) => t.id).map((t) => `[${t.id}] ${t.title || '(untitled)'} — ${t.url || t.pendingUrl || ''}${t.id === workingTab ? '  ← working here' : ''}${opened.has(t.id!) ? ' (Captain\'s tab)' : t.active ? ' (the person\'s, in front)' : ''}`);
        return {text: lines.length ? lines.join('\n') : 'No tabs are open.'};
    }
    case 'browser_open': {
        let url = s(a.url).trim();
        if (!url) {
            throw new BrowserError('Say which address to open.');
        }
        if (!/^[a-z]+:/i.test(url)) {
            url = /^[\w.-]+\.[a-z]{2,}(\/|$|\?|#)/i.test(url) ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
        }
        if (!/^https?:/i.test(url)) {
            throw new BrowserError('Only http and https addresses open here.');
        }
        notBlocked({url});
        let tab: chrome.tabs.Tab;
        const mine = workingTab !== null && opened.has(workingTab) ? await chrome.tabs.get(workingTab).catch(() => null) : null;
        if (a.newTab || !mine) {
            tab = await captainTab(url);
        } else {
            tab = (await chrome.tabs.update(mine.id!, {url})) ?? mine;
            workingTab = tab.id!;
            save();
        }
        await waitLoaded(tab.id!);
        await sleep(400);
        return {text: await snapshot(await tabById(tab.id!))};
    }
    case 'browser_switch': {
        // Reading or working in one of the person's tabs, without bringing it forward.
        const tab = await tabById(Number(a.tabId));
        notBlocked(tab);
        workingTab = tab.id!;
        save();
        return {text: await snapshot(tab)};
    }
    case 'browser_snapshot': {
        const tab = await currentTab(a);
        notBlocked(tab);
        return {text: await snapshot(tab, s(a.query))};
    }
    case 'browser_read': {
        const tab = await currentTab(a);
        notBlocked(tab);
        const p = await run(tab.id!, pageRead);
        return {text: `${p.title} — ${p.url}\n\n${p.text.slice(0, READ_CHARS)}${p.text.length > READ_CHARS ? '\n\n[cut off here]' : ''}`};
    }
    case 'browser_click': {
        const tab = await currentTab(a);
        notBlocked(tab);
        const found = await run(tab.id!, pageFind, [a.ref ? s(a.ref) : null, a.text ? s(a.text) : null]);
        if (!found.ok) {
            throw new BrowserError(found.error!);
        }
        const blocked = gateCheck(tab, {kind: 'click', described: await run(tab.id!, pageDescribe, ['last', null, 0, 0]).catch(() => null)}, a.confirm);
        if (blocked) {
            return blocked;
        }
        await sleep(80);
        const r = await run(tab.id!, pageClick);
        if (!r.ok) {
            throw new BrowserError(r.error!);
        }
        const now = await settle(tab.id!);
        return {text: `Clicked ${a.ref ? s(a.ref) : `"${s(a.text)}"`}.\n\n${await snapshot(now)}`};
    }
    case 'browser_type': {
        const tab = await currentTab(a);
        notBlocked(tab);
        const text = s(a.text);
        const target = await run(tab.id!, pageDescribe, [a.ref ? 'ref' : 'active', a.ref ? s(a.ref) : null, 0, 0]).catch(() => null);
        const secret = secretCheck(target);
        if (secret) {
            return secret;
        }
        const r = await run(tab.id!, pageType, [a.ref ? s(a.ref) : null, text, Boolean(a.append)]);
        if (!r.ok) {
            throw new BrowserError(r.error!);
        }
        let note = `Typed ${text.length} characters${a.ref ? ` into ${s(a.ref)}` : ''}.`;
        if (a.submit) {
            const blocked = gateCheck(tab, {kind: 'key', described: await run(tab.id!, pageDescribe, ['active', null, 0, 0]).catch(() => null), combo: 'Enter'}, a.confirm);
            if (blocked) {
                return blocked;
            }
            await sleep(100);
            note += ` ${await press(tab, 'Enter')}`;
            await settle(tab.id!, 600);
        }
        return {text: `${note}\n\n${await snapshot(await tabById(tab.id!), '')}`};
    }
    case 'browser_press': {
        const tab = await currentTab(a);
        notBlocked(tab);
        const combo = s(a.key);
        const d = await run(tab.id!, pageDescribe, ['active', null, 0, 0]).catch(() => null);
        if (/(cmd|ctrl|command|control|meta)\s*\+\s*v$/i.test(combo)) {
            const secret = secretCheck(d);
            if (secret) {
                return secret;
            }
        }
        const blocked = gateCheck(tab, {kind: 'key', described: d, combo}, a.confirm);
        if (blocked) {
            return blocked;
        }
        const note = await press(tab, combo);
        const now = await settle(tab.id!, 400);
        return {text: `${note}\n\n${await snapshot(now)}`};
    }
    case 'browser_select': {
        const tab = await currentTab(a);
        notBlocked(tab);
        const r = await run(tab.id!, pageSelect, [s(a.ref), s(a.value)]);
        if (!r.ok) {
            throw new BrowserError(r.error!);
        }
        return {text: `Chose "${r.chosen}" in ${s(a.ref)}.`};
    }
    case 'browser_scroll': {
        const tab = await currentTab(a);
        notBlocked(tab);
        const r = await run(tab.id!, pageScroll, [s(a.direction) || 'down', a.ref ? s(a.ref) : null]);
        if (!r.ok) {
            throw new BrowserError(r.error!);
        }
        await sleep(300);
        return {text: `Scrolled ${s(a.direction) || 'down'}.\n\n${await snapshot(tab)}`};
    }
    case 'browser_screenshot': {
        const tab = await currentTab(a);
        notBlocked(tab);
        const img = await picture(tab);
        if (!img) {
            return {text: `"${tab.title}" is in the background and Chrome isn't drawing it, so there's no picture right now. browser_snapshot reads it fine; if you really need to see it, ask the person to press Show me on the little Captain.`};
        }
        return {text: `The tab "${tab.title}" as it looks now. For clicking, use ids from browser_snapshot.`, images: [img]};
    }
    case 'browser_input': {
        // One pixel action from the computer-use engine, in the working tab.
        const tab = await currentTab(a);
        notBlocked(tab);
        const action = (a.action && typeof a.action === 'object' ? a.action : {}) as PixelAction;
        return pixel(tab, action, a.confirm);
    }
    case 'browser_wait': {
        const tab = await currentTab(a);
        const text = s(a.text).trim();
        if (text) {
            const until = Date.now() + 20_000;
            while (Date.now() < until) {
                if (await run(tab.id!, pageHasText, [text]).catch(() => false)) {
                    return {text: `"${text}" is on the page now.\n\n${await snapshot(tab)}`};
                }
                await sleep(500);
            }
            return {text: `"${text}" didn't appear within 20s.\n\n${await snapshot(tab)}`};
        }
        const secs = Math.max(1, Math.min(20, Number(a.seconds) || 2));
        await sleep(secs * 1000);
        return {text: `Waited ${secs}s.\n\n${await snapshot(tab)}`};
    }
    case 'browser_back': {
        const tab = await currentTab(a);
        if (!opened.has(tab.id!)) {
            throw new BrowserError('That\'s the person\'s own tab: Captain doesn\'t navigate it. Open what you need in a Captain tab (browser_open).');
        }
        await chrome.tabs.goBack(tab.id!);
        await waitLoaded(tab.id!, 10_000);
        return {text: await snapshot(await tabById(tab.id!))};
    }
    case 'browser_close': {
        const id = Number(a.tabId);
        if (!opened.has(id)) {
            throw new BrowserError('Only tabs Captain opened can be closed.');
        }
        await chrome.tabs.remove(id);
        opened.delete(id);
        if (workingTab === id) {
            workingTab = null;
        }
        save();
        return {text: `Closed tab ${id}.`};
    }
    default:
        throw new BrowserError(`Chrome can't do ${tool}.`);
    }
}

// Whether a request changes the page (the little Captain gets a new picture after these).
export function isBrowserAction(tool: string): boolean {
    return ['browser_open', 'browser_click', 'browser_type', 'browser_press', 'browser_select', 'browser_scroll', 'browser_back', 'browser_input', 'browser_switch'].includes(tool);
}

export function describeBrowser(tool: string, a: Record<string, unknown>): string {
    const s = (v: unknown, n = 40) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
    switch (tool) {
    case 'browser_open': return `Opening ${s(a.url, 60)}`;
    case 'browser_click': return `Clicking ${a.ref ? s(a.ref) : `"${s(a.text)}"`}`;
    case 'browser_type': return `Typing "${s(a.text, 30)}"`;
    case 'browser_press': return `Pressing ${s(a.key)}`;
    case 'browser_snapshot':
    case 'browser_read': return 'Reading the page';
    case 'browser_screenshot': return 'Looking at the page';
    case 'browser_wait': return 'Waiting for the page';
    case 'browser_input': {
        const act = (a.action ?? {}) as PixelAction;
        return act.type === 'type' ? `Typing "${s(act.text, 30)}"` : act.type === 'keypress' ? `Pressing ${cuaCombo(act.keys ?? [])}` : act.type === 'screenshot' ? 'Looking at the page' : act.type === 'scroll' ? 'Scrolling' : act.type === 'wait' ? 'Waiting' : 'Clicking';
    }
    default: return 'Working in Chrome';
    }
}
