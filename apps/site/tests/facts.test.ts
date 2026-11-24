import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    MENU_PATHS,
    PHONE_ERASE_DAYS,
    PHONE_LOCK_DAYS,
    RELAY_EXPIRE_DAYS,
    SESSION_COOKIE,
    SESSION_DAYS,
} from '../src/build/facts.ts';

import { builtPages, pageHtml, readBuilt, text } from './helpers.ts';

// The legal pages state facts the code decides. Each is read from its source here, so a change in
// the code fails until the policy says the same.

const root = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('the facts the policies state', () => {
    it('the session cookie: __Host- over https, Better Auth’s prefix, 7 days, SameSite=Strict', () => {
        const auth = read('src/server/auth/better-auth.ts');
        const cookies = read('src/server/auth/host-cookies.ts');
        const prefix = /const COOKIE_PREFIX = '([^']+)';/.exec(auth)?.[1];
        const host = /const HOST = '([^']+)';/.exec(cookies)?.[1];
        expect(cookies).toContain("return `${this.secure ? HOST : ''}${this.prefix}.session_token`;");
        expect(`${host}${prefix}.session_token`).toBe(SESSION_COOKIE);
        expect(auth).toMatch(new RegExp(`const SESSION_SECONDS = ${SESSION_DAYS} \\* 24 \\* 60 \\* 60;`));
        expect(auth).toContain("cookies: { session_token: { attributes: { sameSite: 'strict' } } }");
        const cookiesPage = text(pageHtml('cookies'));
        expect(cookiesPage).toContain(
            `${SESSION_COOKIE} Necessary Keeps you signed in to your workspace (HttpOnly, Secure, SameSite=Strict) ${SESSION_DAYS} days`,
        );
    });

    it('the push relay drops a registration 60 days after it last checks in', () => {
        expect(read('apps/push-relay/src/registrations.ts')).toContain(
            `export const EXPIRE_DAYS = ${RELAY_EXPIRE_DAYS};`,
        );
        expect(text(pageHtml('privacy'))).toContain(`dropped ${RELAY_EXPIRE_DAYS} days after a device last checks in`);
    });

    it('the phone locks after 30 days out of reach, and erases itself 30 days later', () => {
        const lease = read('apps/mobile/src/data/lease.ts');
        expect(lease).toContain(`export const LEASE_LOCK_MS = ${PHONE_LOCK_DAYS} * DAY_MS;`);
        expect(lease).toContain(`export const LEASE_WIPE_MS = ${PHONE_ERASE_DAYS} * DAY_MS;`);
        expect(text(pageHtml('privacy'))).toContain(
            `can’t reach the workspace for ${PHONE_LOCK_DAYS} days it locks, and ${PHONE_ERASE_DAYS} days later it erases itself`,
        );
    });
});

describe('the menu paths the pages give', () => {
    /** Where each client shows each label today: [file, the source text that shows it]. */
    const SHOWN: Record<string, [string, string][]> = {
        // The app: the More tab, its Account row and the account screen's Sign out.
        More: [['apps/mobile/src/navigation/tabs.ts', "label: 'More'"]],
        Account: [
            ['apps/mobile/src/screens/more.tsx', 'title="Account"'],
            // The web: the settings nav's second group.
            ['packages/client/src/modules/settings/sections.ts', "label: 'Account',"],
        ],
        'Sign out': [
            ['apps/mobile/src/screens/account.tsx', 'label="Sign out"'],
            // The web's user menu.
            ['packages/client/src/components/nav-user.tsx', "{methods ? 'Sign out' : 'Switch user'}"],
        ],
        'Settings & setup': [['apps/mobile/src/shell/modules.ts', "navLabel: 'Settings & setup'"]],
        Notifications: [['apps/mobile/src/screens/settings.tsx', '<Section title="Notifications"']],
        'Add a device': [['packages/client/src/components/nav-user.tsx', 'Add a device']],
        // The web, for admins: Settings, its People entry, and the person page's footer button.
        Settings: [['packages/client/src/components/app-sidebar.tsx', "settings: 'Settings'"]],
        People: [['packages/client/src/modules/settings/sections.ts', "entry('people', 'People'"]],
        'Deactivate…': [['packages/client/src/modules/settings/people/PersonPage.route.tsx', "'Deactivate…'"]],
        // Leave workspace (CB-383): the web's Account group's Profile entry and its button, the
        // app's account sheet row under Sign out.
        Profile: [['packages/client/src/modules/settings/sections.ts', "entry('account', 'Profile')"]],
        'Leave workspace': [
            [
                'packages/client/src/modules/settings/AccountSettings.tsx',
                '<h3 className="font-medium">Leave workspace</h3>',
            ],
            ['apps/mobile/src/shell/account.ts', "export const LEAVE_WORKSPACE = 'Leave workspace';"],
            ['apps/mobile/src/screens/account.tsx', '<LeaveWorkspace workspaceName={view.workspaceName} />'],
        ],
    };

    it('uses only labels the clients show, from MENU_PATHS', () => {
        for (const label of Object.values(MENU_PATHS).flat()) {
            const places = SHOWN[label];
            expect(places, `${label}: say where a client shows it`).toBeDefined();
            for (const [file, shown] of places ?? []) {
                expect(read(file), `${label} in ${file}`).toContain(shown);
            }
        }
    });

    it('gives on the pages only paths from MENU_PATHS', () => {
        const allowed = new Set(Object.values(MENU_PATHS).map((path) => path.join(' › ')));
        let count = 0;
        for (const key of ['delete-account', 'support', 'privacy', 'terms', 'cookies'] as const) {
            const html = pageHtml(key);
            for (const [path] of html.matchAll(
                /<span class="kbd">[^<]*<\/span>(?: › <span class="kbd">[^<]*<\/span>)*/g,
            )) {
                const labels = [...path.matchAll(/<span class="kbd">([^<]*)<\/span>/g)]
                    .map((match) => (match[1] ?? '').replace(/&amp;/g, '&'))
                    .join(' › ');
                expect(allowed.has(labels), `${key}: ${labels}`).toBe(true);
                count++;
            }
        }
        expect(count).toBe(10);
        // No path written as plain text, outside the key caps.
        for (const key of ['delete-account', 'support'] as const) {
            const outside = pageHtml(key).replace(
                /<span class="kbd">[^<]*<\/span>(?: › <span class="kbd">[^<]*<\/span>)*/g,
                '',
            );
            expect(text(outside), key).not.toMatch(/›|→/);
        }
    });

    it('gives the real steps to leave a workspace, and no “coming soon” for it', () => {
        const page = text(pageHtml('delete-account'));
        const web = MENU_PATHS.webLeave.join(' › ');
        const app = MENU_PATHS.appLeave.join(' › ');
        expect(page).toContain(`On the web, open ${web} and confirm.`);
        expect(page).toContain(`In the Socio app (latest version), open ${app} and confirm.`);
        expect(page).toContain('If your app doesn’t show it yet, use the web.');
        expect(page).toContain('Leaving deactivates your account in that workspace.');
        expect(page).toContain('Your content stays with the workspace. An admin can let you back in.');
        expect(page).toContain('make someone else an admin before you leave');
        expect(page).toContain('make another admin its owner first');
        expect(page).toContain('Leaving doesn’t remove your account for good');
        expect(page).toContain('Signing out doesn’t close your account.');
        // Only the admin portal (CB-386) is still to come.
        expect(page.match(/[Cc]oming soon/g)).toEqual(['Coming soon']);
        expect(page).toContain('Coming soon: an admin portal');
        const support = text(pageHtml('support'));
        expect(support).toContain(`On the web, open ${web} .`);
        expect(support).toContain(
            `In the Socio app (latest version), open ${app} ; if your app doesn’t show it yet, use the web.`,
        );
        // Nowhere does “coming soon” sit near leaving.
        const near = /\bleav(e|ing)\b[^.]{0,80}coming soon|coming soon[^.]{0,80}\bleav(e|ing)\b/i;
        expect(near.test('Leaving a workspace yourself is coming soon.')).toBe(true);
        for (const [key, html] of builtPages()) {
            expect(near.exec(text(html))?.[0], key).toBeUndefined();
        }
        expect(near.exec(readBuilt('llms-full.txt'))?.[0], 'llms-full.txt').toBeUndefined();
    });

    it('says what leaving does as the server does it', () => {
        // The refusals: the workspace's only admin hands the role on first, and
        // its owner hands ownership on first (CB-390).
        const shared = read('packages/shared/src/leave-workspace.ts');
        expect(shared).toContain('Make someone else an admin before you leave');
        expect(shared).toContain('Make another admin its owner');
        // Leaving deactivates: devices end and erase (push registrations dropped), sessions end.
        const auth = read('src/server/auth/better-auth.ts');
        expect(auth).toContain('await this.deactivate(current.id, by, { left: true });');
        expect(auth).toContain("await this.endDevices(accountId, by, 'revoked_and_erase', reason);");
        expect(auth).toContain('await context.internalAdapter.deleteUserSessions(accountId);');
        expect(auth).toContain('await this.dropLeftoverPush(accountId, ended);');
        expect(text(pageHtml('delete-account'))).toContain(
            'You can’t sign in again, your sessions end on every device, each phone erases the workspace’s copy, and your devices stop getting its notifications.',
        );
    });
});

describe('where data goes', () => {
    // Absolute claims a self-hosted workspace can't keep: an operator may point Socio at an
    // outside model provider (src/server/inference/openai-compatible.ts), and the apps reach the
    // push relay. Say what is stored where, and where requests go, instead.
    const ABSOLUTE =
        /never leaves?|nothing (ever )?leaves|(stays?|remains?|kept) (only )?on your (own )?(machines?|servers?|devices?|hardware)|leaves? your (machines?|servers?|devices?|network)|yours alone|only your phone can read|never see (that|your|a) workspace|no one else can|nobody else can|100% private|completely private|fully private/i;

    it('makes no absolute claim on any page, in llms.txt, llms-full.txt or the og cards', async () => {
        const { OG_CARDS } = await import('../src/build/og.ts');
        const sources: [string, string][] = [
            ...builtPages().map(([key, html]): [string, string] => [key, text(html)]),
            ['llms.txt', readBuilt('llms.txt')],
            ['llms-full.txt', readBuilt('llms-full.txt')],
            [
                'og cards',
                Object.values(OG_CARDS)
                    .map((card) => `${card.kicker} ${card.title}`)
                    .join(' '),
            ],
        ];
        for (const [name, content] of sources) {
            expect(ABSOLUTE.exec(content)?.[0], name).toBeUndefined();
        }
        expect(ABSOLUTE.test('Your data never leaves your machines')).toBe(true);
    });

    it('says where a self-hosted workspace keeps its data and sends AI requests', () => {
        expect(text(pageHtml('home'))).toContain(
            'Workspace data stored on your own servers; AI requests go only to the model provider you choose',
        );
        expect(read('src/server/inference/openai-compatible.ts')).toMatch(/baseURL|base_url|fetch\(/);
    });
});

describe('what removing an account deletes and keeps', () => {
    // The company owns its people's work (CB-360): removal refuses while the person still owns
    // anything (purge/person.ts), and an admin moves conversations and memories to someone else
    // first (auth/accounts.ts). So no page may say chats or memories are erased.
    const ERASES_CONTENT =
        /[^.]*\b(chats?|conversations?|memories)\b[^.]*\b(erased?|deleted?|wiped|purged)\b[^.]*|[^.]*\b(erased?|deleted?|wiped|purged)\b[^.]*\b(chats?|conversations?|memories)\b[^.]*/i;

    it('the code: removal refuses while assets remain, and conversations and memories transfer', () => {
        expect(read('src/server/purge/person.ts')).toContain('transfer it to someone first.');
        const accounts = read('src/server/auth/accounts.ts');
        expect(accounts).toContain('conversations: platform.conversations.owned(userId),');
        expect(accounts).toContain('memories: platform.memories.owned(userId),');
    });

    it('no page, nor llms-full.txt, says chats or memories are erased or deleted', () => {
        const sources: [string, string][] = [
            ...builtPages().map(([key, html]): [string, string] => [key, text(html)]),
            ['llms-full.txt', readBuilt('llms-full.txt')],
        ];
        for (const [name, content] of sources) {
            expect(ERASES_CONTENT.exec(content)?.[0]?.trim(), name).toBeUndefined();
        }
        expect(ERASES_CONTENT.test('your private chats and memories are erased')).toBe(true);
        expect(
            ERASES_CONTENT.test('When your personal details are erased: your sign-in, your private chats and memories'),
        ).toBe(true);
    });

    it('says what is deleted, what stays, and whose call it is', () => {
        const page = text(pageHtml('delete-account'));
        expect(page).toContain(
            'On permanent removal: your account and its sign-in data, devices, sessions and notification registrations.',
        );
        expect(page).toContain('Your content stays: chats, memories, pages and board items.');
        expect(page).toContain('For a workspace we host, your company decides what happens to its content.');
        expect(text(pageHtml('privacy'))).toContain('its content stays with the workspace, handed to someone else');
    });
});
