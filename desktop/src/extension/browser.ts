// An agent's browser_* request, done in this Chrome (from the background
// worker). Pages are read as a snapshot: every link, button and field gets
// an id like e12 that the agent clicks and types by. Reading and clicking
// run as scripts in the page; keys go through Chrome's debugger when that
// permission is on, so Enter really submits.

import type {DeviceResult} from '../lib/types';

export const BROWSER_CAPABILITIES = ['browser_tabs', 'browser_open', 'browser_switch', 'browser_snapshot', 'browser_read', 'browser_click', 'browser_type', 'browser_press', 'browser_select', 'browser_scroll', 'browser_screenshot', 'browser_wait', 'browser_back', 'browser_close'];

const SNAPSHOT_CHARS = 14_000;
const READ_CHARS = 40_000;

let workingTab: number | null = null;
const opened = new Set<number>(); // tabs the agent opened (it may close these)

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

async function tabById(id: number): Promise<chrome.tabs.Tab> {
    try {
        return await chrome.tabs.get(id);
    } catch {
        throw new BrowserError(`There's no tab ${id} any more. Use browser_tabs.`);
    }
}

async function currentTab(args: Record<string, unknown>): Promise<chrome.tabs.Tab> {
    const wanted = typeof args.tabId === 'number' ? args.tabId : workingTab;
    if (wanted !== null) {
        try {
            const t = await chrome.tabs.get(wanted);
            workingTab = t.id ?? null;
            return t;
        } catch {
            workingTab = null;
        }
    }
    const [active] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    const tab = active ?? (await chrome.tabs.query({active: true}))[0];
    if (!tab?.id) {
        throw new BrowserError('Chrome has no open tab. Use browser_open with newTab.');
    }
    workingTab = tab.id;
    return tab;
}

async function bringForward(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.id && !tab.active) {
        await chrome.tabs.update(tab.id, {active: true}).catch(() => undefined);
    }
    if (tab.windowId) {
        await chrome.windows.update(tab.windowId, {focused: true}).catch(() => undefined);
    }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function snapshot(tab: chrome.tabs.Tab, filter = ''): Promise<string> {
    const s = await run(tab.id!, pageSnapshot, [filter, SNAPSHOT_CHARS]);
    const head = `${s.title || '(untitled)'} — ${s.url}\n${s.count} elements with ids${filter ? ` matching "${filter}"` : ''}. Ids are good until the next snapshot or page change.`;
    return `${head}\n\n${s.text || '(nothing readable; the page may still be loading — browser_wait, then snapshot again)'}`;
}

// Chrome's debugger gives real key presses (Enter submits, shortcuts work).
// Only when that permission was granted (the popup asks).
let debuggerAllowed: boolean | null = null;
async function canDebug(): Promise<boolean> {
    if (debuggerAllowed === null) {
        debuggerAllowed = await chrome.permissions.contains({permissions: ['debugger']}).catch(() => false);
    }
    return debuggerAllowed;
}

const KEY_CODES: Record<string, {code: string; vk: number; text?: string}> = {
    Enter: {code: 'Enter', vk: 13, text: '\r'}, Tab: {code: 'Tab', vk: 9}, Escape: {code: 'Escape', vk: 27}, Backspace: {code: 'Backspace', vk: 8}, Delete: {code: 'Delete', vk: 46},
    ArrowUp: {code: 'ArrowUp', vk: 38}, ArrowDown: {code: 'ArrowDown', vk: 40}, ArrowLeft: {code: 'ArrowLeft', vk: 37}, ArrowRight: {code: 'ArrowRight', vk: 39},
    Home: {code: 'Home', vk: 36}, End: {code: 'End', vk: 35}, PageUp: {code: 'PageUp', vk: 33}, PageDown: {code: 'PageDown', vk: 34}, ' ': {code: 'Space', vk: 32, text: ' '},
};
const ALIASES: Record<string, string> = {enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', space: ' '};

function parseKey(combo: string): {key: string; mods: string[]} {
    const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
    const last = parts.pop() ?? '';
    const mods = parts.map((m) => m.toLowerCase()).map((m) => ({command: 'cmd', meta: 'cmd', control: 'ctrl', option: 'alt'}[m] ?? m));
    const key = ALIASES[last.toLowerCase()] ?? (last.length === 1 ? last : last);
    return {key, mods};
}

async function debugPress(tabId: number, key: string, mods: string[]): Promise<void> {
    await chrome.debugger.attach({tabId}, '1.3');
    try {
        const modifiers = (mods.includes('alt') ? 1 : 0) | (mods.includes('ctrl') ? 2 : 0) | (mods.includes('cmd') ? 4 : 0) | (mods.includes('shift') ? 8 : 0);
        const special = KEY_CODES[key];
        const base = special ? {key, code: special.code, windowsVirtualKeyCode: special.vk, nativeVirtualKeyCode: special.vk} : {key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0};
        const text = special?.text ?? (key.length === 1 && !mods.includes('cmd') && !mods.includes('ctrl') ? key : undefined);
        await chrome.debugger.sendCommand({tabId}, 'Input.dispatchKeyEvent', {type: text ? 'keyDown' : 'rawKeyDown', modifiers, ...base, ...(text ? {text, unmodifiedText: text} : {})});
        await chrome.debugger.sendCommand({tabId}, 'Input.dispatchKeyEvent', {type: 'keyUp', modifiers, ...base});
    } finally {
        await chrome.debugger.detach({tabId}).catch(() => undefined);
    }
}

async function press(tab: chrome.tabs.Tab, combo: string): Promise<string> {
    const {key, mods} = parseKey(combo);
    if (await canDebug()) {
        try {
            await debugPress(tab.id!, key, mods);
            return `Pressed ${combo}.`;
        } catch {
            // a page the debugger can't attach to: the DOM way
        }
    }
    const r = await run(tab.id!, pagePress, [key, mods]);
    return `Pressed ${combo}${r.note ? ` (${r.note})` : ''}.`;
}

export async function runBrowser(tool: string, a: Record<string, unknown>): Promise<DeviceResult> {
    const s = (v: unknown) => String(v ?? '');
    switch (tool) {
    case 'browser_tabs': {
        const tabs = await chrome.tabs.query({});
        const cur = workingTab ?? (await currentTab({})).id;
        const lines = tabs.filter((t) => t.id).map((t) => `[${t.id}] ${t.title || '(untitled)'} — ${t.url || t.pendingUrl || ''}${t.id === cur ? '  ← working here' : ''}${t.active ? ' (active)' : ''}`);
        return {text: lines.length ? lines.join('\n') : 'No tabs are open.'};
    }
    case 'browser_open': {
        let url = s(a.url).trim();
        if (!url) {
            throw new BrowserError('Say which address to open.');
        }
        if (!/^[a-z]+:/i.test(url)) {
            url = /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(url) ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
        }
        if (!/^https?:/i.test(url)) {
            throw new BrowserError('Only http and https addresses open here.');
        }
        let tab: chrome.tabs.Tab;
        if (a.newTab || workingTab === null && !(await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0]) {
            tab = await chrome.tabs.create({url, active: true});
            opened.add(tab.id!);
        } else {
            const t = await currentTab(a);
            tab = (await chrome.tabs.update(t.id!, {url, active: true})) ?? t;
        }
        workingTab = tab.id!;
        await waitLoaded(tab.id!);
        await sleep(400);
        return {text: await snapshot(await tabById(tab.id!))};
    }
    case 'browser_switch': {
        const tab = await tabById(Number(a.tabId));
        workingTab = tab.id!;
        await bringForward(tab);
        return {text: await snapshot(tab)};
    }
    case 'browser_snapshot': {
        const tab = await currentTab(a);
        return {text: await snapshot(tab, s(a.query))};
    }
    case 'browser_read': {
        const tab = await currentTab(a);
        const p = await run(tab.id!, pageRead);
        return {text: `${p.title} — ${p.url}\n\n${p.text.slice(0, READ_CHARS)}${p.text.length > READ_CHARS ? '\n\n[cut off here]' : ''}`};
    }
    case 'browser_click': {
        const tab = await currentTab(a);
        const found = await run(tab.id!, pageFind, [a.ref ? s(a.ref) : null, a.text ? s(a.text) : null]);
        if (!found.ok) {
            throw new BrowserError(found.error!);
        }
        await sleep(80);
        const r = await run(tab.id!, pageClick);
        if (!r.ok) {
            throw new BrowserError(r.error!);
        }
        await sleep(500);
        const now = await tabById(tab.id!);
        if (now.status === 'loading') {
            await waitLoaded(tab.id!, 10_000);
        }
        return {text: `Clicked ${a.ref ? s(a.ref) : `"${s(a.text)}"`}.\n\n${await snapshot(await tabById(tab.id!))}`};
    }
    case 'browser_type': {
        const tab = await currentTab(a);
        const text = s(a.text);
        const r = await run(tab.id!, pageType, [a.ref ? s(a.ref) : null, text, Boolean(a.append)]);
        if (!r.ok) {
            throw new BrowserError(r.error!);
        }
        let note = `Typed ${text.length} characters${a.ref ? ` into ${s(a.ref)}` : ''}.`;
        if (a.submit) {
            await sleep(100);
            note += ` ${await press(tab, 'Enter')}`;
            await sleep(600);
            const now = await tabById(tab.id!);
            if (now.status === 'loading') {
                await waitLoaded(tab.id!, 10_000);
            }
        }
        return {text: `${note}\n\n${await snapshot(await tabById(tab.id!), '')}`};
    }
    case 'browser_press': {
        const tab = await currentTab(a);
        const note = await press(tab, s(a.key));
        await sleep(400);
        return {text: `${note}\n\n${await snapshot(await tabById(tab.id!))}`};
    }
    case 'browser_select': {
        const tab = await currentTab(a);
        const r = await run(tab.id!, pageSelect, [s(a.ref), s(a.value)]);
        if (!r.ok) {
            throw new BrowserError(r.error!);
        }
        return {text: `Chose "${r.chosen}" in ${s(a.ref)}.`};
    }
    case 'browser_scroll': {
        const tab = await currentTab(a);
        const r = await run(tab.id!, pageScroll, [s(a.direction) || 'down', a.ref ? s(a.ref) : null]);
        if (!r.ok) {
            throw new BrowserError(r.error!);
        }
        await sleep(300);
        return {text: `Scrolled ${s(a.direction) || 'down'}.\n\n${await snapshot(tab)}`};
    }
    case 'browser_screenshot': {
        const tab = await currentTab(a);
        await bringForward(tab);
        await sleep(250);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'png'});
        return {text: `The tab "${tab.title}" as seen now. For clicking, use ids from browser_snapshot.`, images: [dataUrl]};
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
        await chrome.tabs.goBack(tab.id!);
        await waitLoaded(tab.id!, 10_000);
        return {text: await snapshot(await tabById(tab.id!))};
    }
    case 'browser_close': {
        const id = Number(a.tabId);
        if (!opened.has(id)) {
            throw new BrowserError('Only tabs you opened can be closed.');
        }
        await chrome.tabs.remove(id);
        opened.delete(id);
        if (workingTab === id) {
            workingTab = null;
        }
        return {text: `Closed tab ${id}.`};
    }
    default:
        throw new BrowserError(`Chrome can't do ${tool}.`);
    }
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
    default: return 'Working in Chrome';
    }
}
