import {expect, test, type ConsoleMessage, type Page} from '@playwright/test';

// The path a first user walks, in the real product: sign up, land in the
// workspace, send a message, ask @captain, get an answer, see it in the
// thread. Any console error or failed request along the way fails the test.
//
// Keep this to the happy path. A bug fix adds a focused spec next to it (see
// docs/FEATURE_MAP.md for the entry point and selectors of each feature).

const EVIDENCE = 'e2e/evidence';

function watchConsole(page: Page): {errors: string[]} {
    const errors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error') {
            errors.push(msg.text());
        }
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('requestfailed', (req) => errors.push(`request failed: ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`));
    page.on('response', (res) => {
        if (res.status() >= 400) {
            errors.push(`${res.status()} ${res.request().method()} ${res.url()}`);
        }
    });
    return {errors};
}


// Sign-up lands on Home with the "Get started" guide open. Close it and open
// the General group chat, where the composer lives.
async function landInGeneral(page: Page): Promise<void> {
    const guide = page.getByRole('button', {name: 'Done', exact: true});
    await expect(guide).toBeVisible();
    await guide.click();
    await page.getByRole('button', {name: 'General', exact: true}).click();
    await expect(page.getByRole('textbox', {name: 'Message', exact: true})).toBeVisible();
}

test('first run: sign up, post, ask @captain', async ({page}) => {
    const {errors} = watchConsole(page);
    const stamp = Date.now();

    await page.goto('/');
    await expect(page.getByRole('button', {name: 'Create account'}).first()).toBeVisible();
    await page.getByRole('button', {name: 'Create account'}).first().click();

    await page.getByLabel('Your name').fill('Grace Test');
    await page.getByLabel('Work email').fill(`grace+${stamp}@example.com`);
    await page.getByLabel('Password').fill('correct horse battery');
    await page.getByLabel('Team name').fill('Smoke Test Team');
    await page.getByRole('button', {name: 'Create account'}).last().click();

    await landInGeneral(page);
    const composer = page.getByRole('textbox', {name: 'Message', exact: true});
    await page.screenshot({path: `${EVIDENCE}/01-signed-in.png`});

    // A plain message appears in the chat.
    await composer.fill(`hello from the smoke test ${stamp}`);
    await page.getByRole('button', {name: 'Send', exact: true}).click();
    await expect(page.getByText(`hello from the smoke test ${stamp}`)).toBeVisible();

    // Ask Captain. In demo mode it answers without any provider key, and
    // the answer says so. The reply lands in a thread, which opens itself.
    await composer.fill('@captain what can you do here?');
    await page.getByRole('button', {name: 'Send', exact: true}).click();
    await expect(page.getByText(/demo mode/i).first()).toBeVisible({timeout: 45_000});
    await page.screenshot({path: `${EVIDENCE}/02-captain-replied.png`});

    expect(errors, 'console errors / 5xx responses during the run').toEqual([]);
});

test('sign in again with the same account', async ({page}) => {
    const {errors} = watchConsole(page);
    const email = `grace+signin${Date.now()}@example.com`;

    await page.goto('/');
    await page.getByRole('button', {name: 'Create account'}).first().click();
    await page.getByLabel('Your name').fill('Grace Again');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password').fill('correct horse battery');
    await page.getByLabel('Team name').fill('Second Team');
    await page.getByRole('button', {name: 'Create account'}).last().click();
    await landInGeneral(page);

    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Sign in'}).first()).toBeVisible();

    await page.getByLabel('Email or username').fill(email);
    await page.getByLabel('Password').fill('correct horse battery');
    await page.getByRole('button', {name: 'Sign in'}).last().click();
    await expect(page.getByRole('button', {name: 'General', exact: true})).toBeVisible();

    expect(errors).toEqual([]);
});
