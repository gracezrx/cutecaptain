// How to get things done in the apps people use most, by the most direct
// route. The device guide (prompts.ts) adds a "fastest way" section built
// per run from what is actually available: a connected app (exact, no screen
// needed) first, then the person's Chrome, then their Mac's screen. Only the
// recipes for apps the request mentions go into the prompt.

export type Route = {
    tools: Set<string>; // every tool name this run has
    chrome: boolean;
    mac: boolean;
};

type Playbook = {
    app: string;
    // Words in the request (or the conversation) that make this recipe worth including.
    match: RegExp;
    // Connected-app tools that do the job without a browser, in the order to try.
    api?: string[];
    browser?: string[];
    screen?: string[];
};

const enc = 'encodeURIComponent each value';

export const PLAYBOOKS: Playbook[] = [
    {
        app: 'Gmail',
        match: /\b(e-?mails?|gmail|inbox|mail|reply|replies|forward|send (?:it|this|him|her|them)|draft)\b/i,
        api: ['gmail_send_email', 'gmail_create_email_draft', 'gmail_fetch_emails'],
        browser: [
            `Write an email: browser_open https://mail.google.com/mail/?view=cm&fs=1&to=ADDRESS&cc=&su=SUBJECT&body=BODY (${enc}; new lines as %0A). The compose window opens with everything filled in: snapshot, check To, Subject and the body, then click Send. Captain's tab stops before sending and asks the person; that's expected, not an error.`,
            'Find emails: browser_open https://mail.google.com/mail/u/0/#search/QUERY (Gmail search words like from:leo newer_than:7d work), then browser_read for the list; click a subject to open it and browser_read for the thread.',
            'Reply: open the thread, click "Reply" (it only opens the box), type into the message body, then click Send.',
            'Attachments can\'t be added through the page; send a Drive link instead, or use the Gmail tools if they are connected.',
        ],
        screen: ['Mail: computer_open app "Mail", cmd+n for a new message, fill To, Subject and the body (tab moves between them), then cmd+shift+d sends after approval.'],
    },
    {
        app: 'Google Calendar',
        match: /\b(calendar|schedule|meeting|meetings|event|events|agenda|free|busy|availability|invite|book (?:a|time)|tomorrow|today|this week|next week)\b/i,
        api: ['googlecalendar_events_list', 'googlecalendar_find_event', 'googlecalendar_create_event'],
        browser: [
            'See what\'s on: browser_open https://calendar.google.com/calendar/r/agenda (the next days as a list) or https://calendar.google.com/calendar/r/day/YYYY/M/D for one day, then browser_read. Times on the page are the person\'s own time zone.',
            `New event with everything filled in: browser_open https://calendar.google.com/calendar/r/eventedit?text=TITLE&dates=YYYYMMDDTHHMMSS/YYYYMMDDTHHMMSS&details=NOTES&location=PLACE&add=guest1@x.com,guest2@y.com (${enc}; times without a Z are the person's local time). Snapshot to check the title, date, time and guests, then click Save. Saving sends invitations, so Captain's tab asks the person first.`,
        ],
        screen: ['Calendar: computer_open app "Calendar", cmd+2 for week view, computer_read_screen to read the events.'],
    },
    {
        app: 'Outlook',
        match: /\b(outlook|office 365|microsoft 365|hotmail)\b/i,
        browser: [
            `Write an email: browser_open https://outlook.office.com/mail/deeplink/compose?to=ADDRESS&subject=SUBJECT&body=BODY (${enc}), check the fields, click Send.`,
            'Calendar: browser_open https://outlook.office.com/calendar/view/day (or /view/week), then browser_read.',
        ],
    },
    {
        app: 'ChatGPT',
        match: /\b(chat ?gpt|openai)\b/i,
        browser: [
            `browser_open https://chatgpt.com/?q=PROMPT (${enc}) starts a new chat with the prompt already sent. Then browser_wait about 10 seconds and browser_read; read again until the answer stops growing. Copy the answer from browser_read, not from a screenshot.`,
        ],
    },
    {
        app: 'Google Docs, Sheets and Slides',
        match: /\b(google (?:doc|docs|sheet|sheets|slides)|spreadsheet|sheet|doc|document|slides|deck)\b/i,
        api: ['googlesheets_batch_get', 'googlesheets_search_spreadsheets', 'googledocs_get_document_by_id', 'googledocs_search_documents', 'googledrive_find_file'],
        browser: [
            'A new one: browser_open https://docs.new, https://sheets.new or https://slides.new.',
            'Reading a Google Sheet: its cells are drawn, not text. Take the address of the open sheet (…/spreadsheets/d/ID/edit#gid=N) and browser_open …/spreadsheets/d/ID/export?format=csv&gid=N in a new Captain tab, then browser_read: the sheet as plain CSV.',
            'Reading a Google Doc: browser_read works on the open document; …/document/d/ID/export?format=txt gives plain text.',
        ],
        screen: ['Numbers, Pages or Keynote: computer_open the app, then computer_read_screen reads the cells and text.'],
    },
    {
        app: 'Slack',
        match: /\bslack\b/i,
        browser: ['browser_open https://app.slack.com/client, then find the channel or person with the search box (cmd+k), type the message in the message box and press Enter (that sends: Captain asks the person first).'],
        screen: ['Slack app: computer_open app "Slack", cmd+k, type the channel name, enter, then type the message.'],
    },
    {
        app: 'Notion',
        match: /\bnotion\b/i,
        browser: ['browser_open https://www.notion.so, then use its search (cmd+p) to find the page; browser_read gives the page text.'],
    },
    {
        app: 'LinkedIn',
        match: /\blinked ?in\b/i,
        browser: ['Messages: browser_open https://www.linkedin.com/messaging/. A post: browser_open https://www.linkedin.com/feed/?shareActive=true. Sending and posting ask the person first.'],
    },
    {
        app: 'X',
        match: /\b(twitter|tweet|x\.com|post on x)\b/i,
        browser: [`A post: browser_open https://x.com/intent/post?text=TEXT (${enc}), check it, click Post (the person is asked first).`],
    },
];

const CONNECTED = new Map([
    ['gmail_', 'Gmail'], ['googlecalendar_', 'Google Calendar'], ['googlesheets_', 'Google Sheets'], ['googledocs_', 'Google Docs'], ['googledrive_', 'Google Drive'], ['googleslides_', 'Google Slides'],
]);

// The connected apps this run can reach without a browser, by name.
export function connectedApps(tools: Set<string>): string[] {
    const out = new Set<string>();
    for (const t of tools) {
        for (const [prefix, name] of CONNECTED) {
            if (t.startsWith(prefix)) {
                out.add(name);
            }
        }
    }
    return [...out];
}

export function playbooksFor(text: string): Playbook[] {
    return PLAYBOOKS.filter((p) => p.match.test(text));
}

function weekday(d: Date): string {
    return d.toLocaleDateString('en-US', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'});
}

// The "fastest way" section of the device guide. `text` is the request and
// the recent conversation, to pick which app recipes to include.
export function routeGuide(route: Route, text: string, now = new Date()): string {
    const books = playbooksFor(text);
    const apps = connectedApps(route.tools);
    const lines = [
        '',
        '## The fastest way to get it done',
        `Today is ${weekday(now)} (UTC; the person's own day may differ near midnight).`,
        'Pick the most direct route that works, in this order:',
        `1. ${apps.length ? `Connected apps, through their tools (exact, nothing on screen): ${apps.join(', ')}.` : 'Connected apps: none are connected for this person, so go straight to the next route.'}`,
        `2. ${route.chrome ? 'Their Chrome, in Captain\'s own background tabs (browser_*): their logins are there, and they can keep using their own tabs while you work.' : 'Their Chrome: not connected.'}`,
        `3. ${route.mac ? 'Their Mac\'s screen (computer_*): for native apps, and anything the first two can\'t do. It takes over their mouse, so use it last.' : 'Their Mac\'s screen: not connected.'}`,
    ];
    for (const b of books) {
        const api = (b.api ?? []).filter((t) => route.tools.has(t));
        const parts: string[] = [];
        if (api.length) {
            parts.push(`- Connected: ${api.join(', ')}. Use these first.`);
        }
        if (route.chrome && b.browser?.length) {
            parts.push(...b.browser.map((r) => `- In Chrome: ${r}`));
        }
        if (route.mac && b.screen?.length) {
            parts.push(...b.screen.map((r) => `- On the screen: ${r}`));
        }
        if (parts.length) {
            lines.push('', `### ${b.app}`, ...parts);
        }
    }
    lines.push(
        '',
        'In Chrome, a page you open goes in a Captain tab in the background; the person sees what you\'re doing on the little Captain. If a page needs a sign-in, a code or a CAPTCHA, use hand_over and wait.',
        'Before anything is sent, posted, paid, booked or deleted, Captain\'s tab and the screen tools stop and ask the person. When that happens, wait for the answer; never look for another button that does the same thing.',
    );
    return lines.join('\n');
}
