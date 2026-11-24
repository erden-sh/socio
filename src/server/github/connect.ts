import { randomBytes } from 'node:crypto';

import { GitHubApp } from './api.js';
import { type GitHubAdminShape, GITHUB_HOSTS, GitHubError, type GitHubOptions } from './contract.js';
import { FlowStateError, SealedAppError } from './settings.js';

/**
 * "Connect GitHub" (CB-32), GitHub's App manifest flow, for one admin at a
 * time:
 *
 * 1. `start`: a state, and the address of `manifestPage`, which posts the
 *    manifest to GitHub (under the repository's owner). The admin selects
 *    Create there.
 * 2. GitHub sends the admin back to Settings with a one-time code; the page
 *    hands it to `created`, which exchanges it for the App's id and private
 *    key, server to server, and stores them sealed. Then the App's install
 *    page; the admin selects Install.
 * 3. GitHub sends the admin back with the installation's id; `installed`
 *    checks it is this App's on the owner's account and records it.
 *
 * The private key goes from GitHub's answer into the sealed setting, and
 * nowhere else: not to a page, a log, a Dot or a coding agent.
 */
export interface ConnectDeps {
    settings: GitHubAdminShape;
    /** The app's public origin: where GitHub sends the admin back. */
    appOrigin?: string;
    github?: GitHubOptions;
    log: (line: string) => void;
}

/** Where GitHub sends the admin back: Settings → General, which finishes each step. */
export const RETURN_PATH = '/settings/workspace';
/** The page that posts the manifest to GitHub. */
export const MANIFEST_PATH = '/api/github/manifest';

const hosts = (deps: ConnectDeps) => deps.github?.hosts ?? GITHUB_HOSTS;
const origin = (deps: ConnectDeps) => {
    if (!deps.appOrigin) {
        throw new FlowStateError('Set APP_ORIGIN first: GitHub sends you back to the app’s address.');
    }
    return deps.appOrigin.replace(/\/$/, '');
};

/** Step 1: checks the repository, then a state for the manifest page. */
export async function start(deps: ConnectDeps, userId: string) {
    origin(deps);
    if (await deps.settings.appUnreadable()) {
        throw new SealedAppError(
            'The GitHub App saved here can’t be opened (its data key is gone). Select Disconnect first, then Connect GitHub.',
        );
    }
    const { repository } = await deps.settings.inForce();
    if (!repository) {
        throw new FlowStateError('Save the repository first (owner/name).');
    }
    const owner = repository.split('/')[0];
    const state = await deps.settings.startFlow(userId, 'create', owner);
    deps.log(`GitHub: connect started by user=${userId}`);
    return { url: `${MANIFEST_PATH}?state=${encodeURIComponent(state)}` };
}

/** The App GitHub is asked to make: no webhooks, no more than coding sessions need. */
export function manifest(appOrigin: string) {
    const site = appOrigin.replace(/\/$/, '');
    return {
        // Names are unique on GitHub; the admin may change it there.
        name: `Socio ${randomBytes(2).toString('hex')}`,
        description: 'Pushes the branches of Socio’s coding sessions and opens draft pull requests for review.',
        url: site,
        redirect_url: `${site}${RETURN_PATH}`,
        setup_url: `${site}${RETURN_PATH}`,
        setup_on_update: false,
        public: false,
        // Never `workflows` (nor administration, secrets, actions…): a
        // coding agent's branch must not be able to change CI, which runs its code.
        // An admin must not add it on GitHub either (docs/SETUP.md).
        default_permissions: {
            contents: 'write',
            pull_requests: 'write',
            metadata: 'read',
        },
        default_events: [],
        request_oauth_on_install: false,
    };
}

const escape = (text: string) => text.replace(/[&"'<>]/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The manifest page (a top-level GET from Settings, with the session):
 * the form GitHub's manifest flow asks for, posted at once by a script
 * with this response's nonce; without JavaScript, a button. Its CSP lets
 * the form go to GitHub. The state is checked, not used up.
 */
export async function manifestPage(deps: ConnectDeps, userId: string, state: string, nonce: string) {
    const site = origin(deps);
    const { owner } = await deps.settings.checkFlow(state, userId, 'create', false);
    const web = hosts(deps).web;
    const type = await GitHubApp.accountType(owner, deps.github);
    const action = `${web}${type === 'Organization' ? `/organizations/${encodeURIComponent(owner)}` : ''}/settings/apps/new?state=${encodeURIComponent(state)}`;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect GitHub</title></head><body style="font-family:system-ui,sans-serif;margin:2rem"><form id="manifest" method="post" action="${escape(action)}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest(site)))}"><p>Taking you to GitHub to create the App for ${escape(owner)}…</p><button type="submit">Continue to GitHub</button></form><script nonce="${nonce}">document.getElementById('manifest').submit()</script></body></html>`;
    return { html, formAction: web };
}

/**
 * Step 2: the code from GitHub's redirect becomes the App's id and key,
 * stored sealed; then the App's install page, with a new state.
 */
export async function created(deps: ConnectDeps, userId: string, input: { code: string; state: string }) {
    origin(deps);
    const { owner } = await deps.settings.checkFlow(input.state, userId, 'create', true);
    const app = await GitHubApp.convertManifest(input.code, deps.github);
    if (app.owner.toLowerCase() !== owner.toLowerCase()) {
        throw new GitHubError(
            `The App was created under ${app.owner}, not ${owner}, so it can’t be installed on the repository. Delete it on GitHub and connect again, creating it under ${owner}.`,
        );
    }
    await deps.settings.saveApp(app);
    deps.log(`GitHub: App ${app.id} (${app.slug}) connected by user=${userId}`);
    const state = await deps.settings.startFlow(userId, 'install', owner);
    return {
        url: `${hosts(deps).web}/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`,
    };
}

/** Step 3: records the installation, once GitHub confirms it is this App's on the owner. */
export async function installed(deps: ConnectDeps, userId: string, input: { installationId: string; state: string }) {
    const { owner } = await deps.settings.checkFlow(input.state, userId, 'install', true);
    const credentials = await deps.settings.connectedApp();
    const installation = await new GitHubApp(credentials, deps.github).installation(input.installationId);
    if (installation.account.toLowerCase() !== owner.toLowerCase()) {
        throw new GitHubError(`The App was installed on ${installation.account}, not ${owner}.`);
    }
    await deps.settings.saveInstallation(installation.id);
    deps.log(`GitHub: App installation ${installation.id} recorded by user=${userId}`);
}
