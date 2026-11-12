// The device's own stop (src/lib/gate.ts): which buttons and keys wait for
// the person, which fields are never typed into, which sites are off limits.
// Run: npm test (Node runs the TypeScript directly).

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {blockedSite, cardDetails, displayLabel, isOutbound, isSecretField, isSendKey, normalizeLabel, targetOf} from '../src/lib/gate.ts';

describe('gate', () => {
    it('stops at buttons that send, post, pay, book or delete', () => {
        for (const label of ['Send', 'Send ‪(⌘Enter)‬', 'Send now', 'Schedule send', 'Post', 'Publish', 'Pay $42.00', 'Place your order', 'Buy now', 'Delete forever', 'Delete 3 conversations', 'Confirm and pay', 'Transfer', 'Unsubscribe', 'Book now', 'Send invitation']) {
            assert.equal(isOutbound(label, 'mail.google.com'), true, label);
        }
    });

    it('lets harmless buttons through, even when they look alike', () => {
        for (const label of ['Reply', 'Reply all', 'Forward', 'Compose', 'Search', 'Next', 'Continue', 'Sign in', 'Save draft', 'Cancel', 'Close', 'Attach files', '', 'A very long label that is clearly a paragraph of text and not a button at all, with send in it']) {
            assert.equal(isOutbound(label, 'mail.google.com'), false, label);
        }
    });

    it('Save sends invitations on calendars, not elsewhere; sending a prompt to an assistant is the job itself', () => {
        assert.equal(isOutbound('Save', 'calendar.google.com'), true);
        assert.equal(isOutbound('Save', 'docs.google.com'), false);
        assert.equal(isOutbound('Send prompt', 'chatgpt.com'), false);
        assert.equal(isOutbound('Send message', 'claude.ai'), false);
        assert.equal(isOutbound('Send message', 'app.slack.com'), true);
    });

    it('knows the keys that send', () => {
        for (const k of ['cmd+enter', 'Cmd+Enter', 'ctrl+enter', 'cmd+shift+d', 'command+return']) {
            assert.equal(isSendKey(k), true, k);
        }
        for (const k of ['enter', 'cmd+a', 'tab', 'shift+enter']) {
            assert.equal(isSendKey(k), false, k);
        }
    });

    it('never types into password, code or card fields', () => {
        assert.equal(isSecretField({type: 'password'}), true);
        assert.equal(isSecretField({autocomplete: 'one-time-code'}), true);
        assert.equal(isSecretField({autocomplete: 'cc-number'}), true);
        assert.equal(isSecretField({subrole: 'AXSecureTextField'}), true);
        assert.equal(isSecretField({label: 'Verification code'}), true);
        assert.equal(isSecretField({label: 'Card number'}), true);
        assert.equal(isSecretField({type: 'text', label: 'Subject'}), false);
        assert.equal(isSecretField({type: 'email', autocomplete: 'username', label: 'Email'}), false);
    });

    it('stays off banks, payments, password managers and account security', () => {
        for (const h of ['www.chase.com', 'paypal.com', 'my.1password.com', 'myaccount.google.com', 'accounts.google.com', 'appleid.apple.com', 'chromewebstore.google.com']) {
            assert.equal(blockedSite(h), true, h);
        }
        for (const h of ['mail.google.com', 'calendar.google.com', 'chatgpt.com', 'www.notion.so']) {
            assert.equal(blockedSite(h), false, h);
        }
    });

    it('describes the target so an approval covers exactly that email', () => {
        assert.equal(normalizeLabel('Send ‪(⌘Enter)‬'), 'send');
        assert.equal(displayLabel('Send ‪(⌘Enter)‬'), 'Send');
        const details = cardDetails([{label: 'Message Body', value: 'Hi Leo'}, {label: 'Subject', value: 'Tuesday'}, {label: 'To', value: 'leo@launchcrew.co'}]);
        assert.deepEqual(details.map((d) => d.label), ['To', 'Subject', 'Message Body']);
        const a = targetOf('mail.google.com', 'Send', details);
        assert.equal(a, targetOf('mail.google.com', 'Send ‪(⌘Enter)‬', details), 'the same button, however it is labelled');
        assert.notEqual(a, targetOf('mail.google.com', 'Send', cardDetails([{label: 'To', value: 'someone-else@x.com'}, {label: 'Subject', value: 'Tuesday'}])), 'a different email is a different target');
    });
});
