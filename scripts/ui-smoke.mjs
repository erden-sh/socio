#!/usr/bin/env node
// Browser smoke test for a running Socio server (it starts nothing).
//
//   node scripts/ui-smoke.mjs --base http://127.0.0.1:4398 [--scenario chat|users|people|research|learning|links|covers|search|shell|tabs|routes|ssr|skew|issues|operator|byo|data|views|schedules|auto|phases|media|mobile-fit|notifications|releases|whats-new|operations|operations-access|ops-activity|operations-knowledge]
//     [--shots DIR]                                     (covers, data, views, schedules, media, mobile-fit, notifications, releases, whats-new, operations, operations-access, ops-activity, operations-knowledge: screenshots, light and dark; auto)
//     [--chat-id ID]                                    (operations-access: a chat with turns to read)
//     [--routes home,chat,…]                            (mobile-fit: only these views)
//     [--insecure] [--admin-user ID --member-user ID] [--operator-user ID]          (mock, loopback)
//     [--locale L]                                      (the browser's language, e.g. sv-SE)
//     [--admin-email E --member-email E [--operator-email E] --password-file F]   (Better Auth)
//
// "alice" and "bob" below are the admin and member: on a local mock-auth
// server its first admin and member (or --admin-user and --member-user); on a server
// with Better Auth, email-and-password test accounts an admin created
// (--admin-email, --member-email, --password-file; see brain-client.mjs
// testUsers). At the end it deletes the conversations it created and
// restores socio settings the learning scenario changed.
//
// chat: signs in as alice and drives headless Chromium through a real
// conversation against the server's configured model, then reloads and checks
// that history and the generated title come back. Then the chat menu
// (CB-66): a chat of its own is renamed from its sidebar row (Enter saves,
// Escape keeps) and from the header, which a second tab sees within a
// poll; right-click opens the same menu (Rename, Archive, Delete). Archive
// from the row leaves the chat for a new one with its socio, gone in both
// tabs, and the toast's Undo brings it back; archived again from the
// header, its link opens it with "This chat is archived", and Account →
// Archived chats lists it and unarchives it.
// Delete from the header asks first, lands on a new chat with the socio,
// and the chat is gone in both tabs. Then a Telegram team topic (CB-73), when the workspace lists one
// (tests/fixtures/seed-team-topic.ts seeds one on a local server): alice
// and then bob open it, and a toast, a refused request or a console error
// fails the run.
// With the scripted fake
// model (tests/fixtures/serve-fake-model.ts) it also checks the transcript
// and composer (CB-66): Copy under a reply (the clipboard gets its
// Markdown), no text below 10 px, the status line (13 px, "Waiting for … ·
// N s", nothing in the header), following and "Scroll to end" over long
// answers and a streaming one, and the composer's approval bar (1 of 2,
// Show request, Approve, lifted by a decision elsewhere, the draft kept).
// users: runs chat as alice, switches to bob (a member), checks that bob sees
// none of alice's conversations and no management controls, and Create Space
// exactly when the server's "create Spaces" permission lets him (everyone by
// default, CB-181), has bob chat, then checks that alice sees only her own
// conversation.
// people: Better Auth only (skips on mock auth), no model needed, creates
// nothing. With bob signed in in a second browser, alice deactivates him
// from Settings → People (his row's ⋯ menu): the impact preview names him,
// says his chats, pages and files stay, and its button names him; his row
// gets a Deactivated badge and its menu only Reactivate; bob's open tab
// drops to the sign-in screen, and his password is refused with "This
// account is deactivated…". Alice reactivates him (a confirm that says
// what doesn't come back) and bob signs in again. A run that stops in
// between reactivates him in the cleanup. With --shots, screenshots of the
// preview and the badge.
// learning: as alice, assigns the socio to a container and opens Learning.
// With the flag learning-analyze-now on, runs a manual analysis (Analyze now);
// off (the default), checks that the button isn't there and its route
// answers 404. Then checks that bob sees only published skills.
// research: signs in as alice and asks for a web-sourced answer with a URL.
// links: loopback only, no model needed. Creates two pages and clicks an
// external, a javascript: and an old-style (`/#/spaces/…`) page link in the
// editor. Then deletes the linked page from its page menu (the confirm
// names it; the Space no longer lists it), follows the link again to the
// "This page was deleted" state, and deletes the other page from the
// library's row action.
// covers: loopback only, no model needed (CB-308). Creates two pages and
// a cover image (drawn in the page, nothing fetched). As alice, Add cover
// shows on hovering the title; the picker uploads the image into her Files
// and it becomes a 200 px band; Remove, then the toast's Undo, puts the
// same cover back; Change cover offers the Space's images and one is
// picked. The library gives every card a band (the cover, or the page
// tile). On a 390 px touch phone, Change cover shows without hover, and the
// page, the open picker and the library fit the screen. With --shots, the
// page, the picker and the library at 1440 and 390 px (and Add cover at
// 1440), light and dark.
// Deletes the pages and the file at the end.
// search: loopback only, no model needed. Creates a page whose made-up
// word is only in its body. As alice, types the word into
// ⌘K: the page comes as a text hit with the word marked in its snippet and
// a freshness note ("Edited today"); a misspelling shows "Showing results
// for …" and "Search instead for …", which searches the misspelling (and
// finds nothing); the middle of the word finds it too (trigram). Opens the
// hit (a use is recorded), searches the Space library's box (the snippet
// card and its freshness), deletes the page and searches again: gone.
// Deletes the page at the end if it stopped in between.
// shell: no model needed, creates nothing. Switches the theme to dark (the
// account menu) and back (the header toggle), with a reload and a check that
// the first paint is dark. Collapses the sidebar (Ctrl+B and
// the toggle), checks the state survives a reload and frees the space,
// reaches every sidebar destination as alice, checks the home launcher's
// module cards for each role and that a module page's header renders the
// header.actions slot (Report issue); at 390 px, that the header's controls
// (Pause, Report issue, Ask a socio, Help, the computer) are in its ⋯ menu. Checks bob sees no admin items (but
// his own Runs, CB-128), opens
// and uses the mobile navigation sheet, and opens Report issue from the
// account menu there.
// tabs: no model needed (with one, also a chat across tabs); creates one
// conversation, deleted in the run.
// Two tabs in one browser context (one session cookie), signed in as
// alice. Signs out in tab A: tab B shows the sign-in screen without a
// reload (auth-channel.ts). Signed out, neither tab asks /api/state for
// 10 s (no signed-out poll). Signs in again in tab A: tab B is back in the
// shell, still without a reload. Then writes across tabs (CB-74,
// change-channel.ts): with a model, the same chat open in both tabs, a
// message sent in tab A and the socio's reply show in tab B without a
// reload, and tab B's catch-up sends no note back (tab A asks nothing
// after it); a chat renamed in tab A shows in tab B's header
// within 1.5 s (the poll is 3 s); deleted in tab A, tab B leaves it within
// 1.5 s and never asks for its capture again (no console 404); and tab B,
// hidden for half a second, asks nothing when shown, while hidden for
// 2.5 s it re-reads the shell and revalidates its page (Media) once.
// routes: no model needed; creates one page on loopback when the first Space
// has none (nothing elsewhere). Opens every view by URL and reloads it,
// walks back and forward, finds a page and a module with the ⌘K / Ctrl+K
// palette and opens them, opens old hash links (`/#/spaces/…`) and checks
// they land on the path, and checks bob opens his own turns at /runs
// (CB-128).
// ssr: no model needed (the server must have one set up); creates one
// conversation as alice, deleted at the end. Pages rendered on the server
// (CB-61), read in a browser with JavaScript off. Signed out: the sign-in
// screen at the address asked for, naming nobody. Signed in as alice: the
// sidebar, her new conversation in it, the launcher's module cards (Runs
// among them) and her name; Memories and Activity show their content; an
// unknown address answers 404 inside the shell. As bob: his name, his own
// Runs card and item (CB-128), none of alice's conversations and no admin
// setup in the page or its data, and /runs his own turns. Every page
// has a CSP with a nonce and is not cached. A link to Memories from another
// site (a page the browser fakes) opens it signed in, with JavaScript and
// without: the server opens it again from this site, which sends the
// SameSite=Strict session cookie.
// skew: no model needed, creates nothing. A tab on the previous build after
// a deploy (CB-61): Memories' page chunk answers 404 once, and the click
// loads the page again, after which the next click lands; the route
// manifest answers as a newer build's (204, X-Remix-Reload-Document), and a
// click into Data loads /data as a page; with the manifest still answering
// so, a tab that comes back into view asks about its build, and its next
// click on a link the router already knows (Issues), then the palette's
// Go to Memories, loads that page from the server (step 5); so does a click
// on Data once the shell's poll answers again after failing (the server
// away for a deploy), which makes the tab ask at once; the editor's
// chunk fails once, and the page reloads once and opens the editor (when
// the first Space has a page).
// issues: no model needed. As bob (member), files an issue from the
// header's Report issue with a small PNG attached; as alice (admin), finds
// it on the board, drags it from Triage to Open, opens it, sets the
// priority and comments; checks the list view is remembered over a reload;
// then as bob sees the new column, priority and comment, and that the board
// is read-only for him. Deletes the issue at the end.
// operator: no model chat needed. As an admin (the first mock admin,
// --operator-user, or --operator-email or --admin-email with Better
// Auth), opens Platform from the sidebar (/settings/operator), finds the
// default backend, runs its Test (it must pass: a local call from the
// server to the backend's /models), and switches the first bring-your-own
// kind's "Allow" on and back (if the server has one). Then as alice and bob,
// unless they are admins themselves (CB-390: admins see Platform), checks
// there is no Platform item, /settings/operator sends them home and
// /api/inference answers 403. Skips with a message when no admin is
// configured.
// byo: needs a fake ChatGPT (tests/fixtures/serve-fake-chatgpt.ts; the server
// started with CHATGPT_AUTH_ISSUER and CHATGPT_BASE_URL pointing at it),
// never the real one. As the admin, finds ChatGPT and its model on
// Platform and allows it (if it isn't). As bob, connects ChatGPT in
// Account → Inference (the device code and sign-in link show, then
// Connected with the plan), chats with a socio and gets the fake's answer (its
// reasoning summary folded above it under "Thought for Ns"),
// and disconnects. Restores the allowed kinds and disconnects at the end
// if it stopped in between. Skips without an admin.
// phases: needs the scripted fake model (as data). As alice, asks a socio for
// "smoke phases": the fake waits 3 s, reasons for 6 s, then answers. The
// status line at the end of the chat must name the model while waiting,
// then show the socio thinking, and go away with the answer; the header never
// says "Thinking…". The reasoning must be seen streaming, folded
// ("Thinking"), then reads "Thought for Ns" (N from 4 to 20, a loaded host
// stretches it), opens on a click, and after a reload still reads "Thought
// for Ns" (stored runs keep their events' times, CB-72).
// data: needs the scripted fake model (tests/fixtures/serve-fake-model.ts;
// the server started on a fresh database with OPENAI_BASE_URL pointing at
// it), never a real one. As alice, asks a socio to keep "smoke data": the
// fake has the socio create a table in its scratch dataset, upsert three
// rows and ask to create a dataset, which shows as an approval card in the
// chat; approves it there. Then opens Data, finds the scratch dataset,
// browses its table, runs a read-only query, exports CSV (checks the
// download), checks Approvals lists the decision, and deletes the scratch
// dataset from its page. With --shots, saves screenshots (light and dark).
// Deletes the datasets it made at the end if it stopped in between.
// views: loopback only, needs the same scripted fake model. As alice,
// creates a page and asks a socio for a "smoke view" of it: the fake fills
// smoke_sales in the socio's scratch dataset and embeds a bar chart with
// insert_dataset_view. Opens the page: the chart draws, with the "only
// you can see this" note. Edits the view in place to a line chart, and
// inserts a second view (a table) from the / block menu; both are saved
// into the page's Markdown. As bob, sees the no-access placeholder on
// both; once alice shares the dataset with the page's Space, bob sees the
// chart and the table. With --shots, screenshots (light and dark).
// Deletes the page and the dataset at the end.
// schedules: needs the scripted fake model (as data) and the stand-in
// computers (tests/fixtures/serve-fake-computer.ts; the server started with
// COMPUTER_SUPERVISOR_URL pointing at it, any COMPUTER_SUPERVISOR_TOKEN and
// COMPUTER_TOKEN, and DATA_API_URL). As alice, enables the first socio's
// computer, asks it for a "smoke schedule": it saves a job and proposes a
// daily schedule, two approval cards; approves both. Schedules a task with
// the conversation's clock button (the existing dialog). On Schedules &
// jobs, finds both schedules, pauses and resumes one, runs the job, reads
// its logs and code; the admin sees the workspace's counts. As bob, sees none of it.
// Cancels the schedules; deletes the job and the conversations at the end.
// auto: needs the same scripted fake model (it approves auto reviews). As
// alice, sets Create datasets to Auto on Approvals (the banner shows),
// saves guidance, then asks a socio for "smoke data": the dataset request is
// approved by auto review, and the chat card says so with the reason. On
// Approvals, filters to auto reviews, finds the decision with its badge and
// undoes it (the dataset is deleted), then turns auto off from the banner.
// With --shots, screenshots. Restores the policy and guidance and deletes
// the datasets at the end.
// media: needs the scripted fake model (as data), with the server started
// with MODEL_ACCEPTS_IMAGES=true. As alice, opens a new chat, pastes a small
// PNG (a DataTransfer built in the page) and drops a .md file: both upload,
// the PNG with a thumbnail of the original; removes the .md and drops it
// again. Sends "smoke media": the fake says it got one image and one file
// note. The bubble shows the thumbnail and the file chip, also after a
// reload. bob gets 404 for alice's attachments. With --shots, screenshots
// (light and dark). On /media, the attachments are listed under
// attachments/<day>/ with a link to the chat; makes a folder, uploads a
// text file into it, previews and downloads it, renames it and deletes it.
// Deletes the attachments' files and the folder at the end.
// mobile-fit: no model needed; creates one page on loopback when the first
// Space has none (deleted at the end). An iPhone-sized phone (390×844,
// touch) visits every view as alice and bob (sign-in, Home, a chat and a
// socio's pages, Spaces, a page, one with a title that wraps (CB-202) and its Markdown source, the board and an
// issue, Schedules and a schedule, Activity, Memories, Learning, Runs,
// Data and a dataset (CB-162), Media, Approvals, Apps, Settings and its
// sections, Platform and its backend editor, the socios admin pages,
// Connected agents and /connect, the release notes and a release), and
// opens the navigation sheet, Report issue, a socio's Rename and All
// settings, and the ⌘K palette (CB-96); on
// loopback, a chat of alice's with long unbreakable lines in an approval
// card and a reply (the fake model's "smoke wide", CB-107). Each
// fails when the page is wider than the screen (naming what sticks out)
// or shows an editable field under 16px, which iOS zooms in on when it is
// focused (the zoom stays in the installed app). It reports every view
// before it fails; --routes runs only the views named (the names in the
// table it prints), and --shots saves the failing views, light and dark.
// notifications: no model needed, creates nothing it doesn't remove
// (CB-114). The browser context is granted the notifications permission
// (headless Chromium still says "denied", so the page is told
// "granted"). As alice, opens Settings → Account → Notifications: the
// push-only service worker (public/sw.js) is registered, and each channel
// the server lists has its card (push at least). The shell's /api/state
// poll carries the tab's presence (in use on /settings/notifications
// after a click). Switches push to Private and back, each saved (read back
// from /api/notifications/channels, and kept over a reload). Sends a test
// notification and reads the result ("Sent to …" or "No channel is on");
// on a deployment that is a real test to alice's channels that are on.
// Then "Turn on for this browser": headless Chromium gets no real
// subscription, so either it is on (and the device is removed again) or a
// clean error shows. Start a local server with
// PUSH_ENDPOINT_HOSTS=push.invalid so that no subscription is accepted and
// the server never calls a push service. With --shots, screenshots of the
// section (and of the error), light and dark. Restores alice's
// notification choices at the end if it stopped in between.
// operations: no model needed, creates nothing (CB-184). As bob (a member):
// /api/operations/* answers 403, the sidebar has no Operations, and
// /operations sends him home. As alice: Operations in the sidebar's bottom
// group opens Overview with six tiles, the range bar (7 days pressed, days
// in the reporting time zone) and the turns list; 30d and a socio filter
// are in the address and survive a reload, the section nav keeps them, a
// filter clears, and Back goes to the view before. Reliability (CB-189)
// shows its tiles, the recent failures and the board, and fits a phone.
// Health (CB-192) shows backups and freshness, and fits a phone.
// Operations → Settings shows the reporting time zone. With --shots,
// Overview, Reliability, Health and Settings at 1440 and 390 px, light
// and dark.
// operations-access (CB-188): needs a model unless --chat-id names a chat
// with turns (seed-long-chat.ts makes one), else bob (a member) makes an
// empty one. bob gets 403 from its admin transcript and from the access
// log. As alice: the chat's transcript opens read-only, with the note
// that it is logged and no composer; its link opens Operations → Access
// log, whose newest entry is that open. Both fit a 390 px phone. With
// --shots, both at 1440 and 390 px, light and dark. Deletes bob's chat if it made one.
// ops-activity: no model needed, creates nothing (CB-190). As alice:
// Operations → Activity shows six tiles, the channels and the people,
// socios and chats lists; a person's name narrows the page to them (in the
// address); Value shows its five tiles, how sessions ended and the
// sessions list; Settings has the session gap. Neither page is wider than
// a 390 px phone. With --shots, Activity, Value and the session gap at
// 1440 and 390 px, light and dark.
// operations-knowledge: no model needed, creates nothing (CB-191). As bob
// (a member) /api/operations/{knowledge,storage,capabilities} answer 403.
// As alice the answers carry the four data space limits in force and the
// coverage matrix (no tool without a module or a capability); Knowledge
// shows its tiles, the Spaces, pages, search, dataset access, storage and
// limits, and Capabilities the gaps, the matrix and the requests. Both fit
// a 390 px phone. With --shots, both at 1440 and 390 px, light and dark.
// releases: no model needed, creates nothing (CB-165, CB-168). As bob (a
// member), opens Release notes from the account menu: /releases lists the
// releases newest first, a page at a time as it scrolls, until it shows
// every one /api/releases does, the running version is
// in the heading and on the newest card ("Current"), the newest's full
// notes are open and its highlights and notes link issue keys to Socio's
// own board, https://brain.ingenioventures.com/issues/CB-n, in a new tab
// (CB-381; never followed, so nothing leaves loopback). Another release's Full notes opens them. /releases/<tag>
// of the oldest release opens it, scrolled into view; an unknown tag says
// so. Settings shows the version, linking to the page; /healthz says the
// version, and /api/releases answers 401 signed out. With --shots,
// screenshots at 1440 and 390 px, light and dark.
// whats-new: no model needed; creates one chat, deleted at the end
// (CB-166). As alice at 1440 px (having seen the second newest release,
// on a fresh database), Home lists the five most recent releases under
// What's new (CB-333: fewer only if there are fewer), newest first, in a
// box of at most 34rem that loads no more as it scrolls, with an "All
// releases" link; the header's What's new button (a gift) opens from the
// keyboard, scrolls to every release too, marks the newest as seen on the
// server (its dot, if it had one, goes) and gives focus back on Escape;
// the cards she was shown are recorded, as an admin reads them per person.
// Then on a 390 px phone: the socios stay above the fold, and the open list
// fits the screen; and at 360 px, in a chat, an admin's header is the
// title, one status indicator and ⋯ (which holds Pause, What's new and the
// chat's menu), and the chat's title keeps at least 100 px. With --shots, Home and the open list,
// desktop and phone, and the 360 px header, light and dark.
// chat, users and research start their chats from a socio card on the `/`
// launcher.
// --locale runs Chromium in that language (its Intl default and
// Accept-Language), for example sv-SE or da-DK: the server renders in
// en-US, so a page that sorts or formats text in the browser's default
// locale mismatches on hydration and fails the run.
// Every scenario waits for React to hydrate a page it loads (goto, reload,
// hydrated) before it clicks, so a click never lands on server-rendered
// markup that React hasn't attached to yet.
// Exits non-zero on a failed step, a browser console error (a `[hydration]`
// mismatch always), or any browser request or WebSocket to a host other
// than the app's origin and loopback (where the test fixtures listen). Those
// are blocked as well as reported, in every browser context, so nothing
// leaves: CopilotKit's inspector, for one, would post to
// telemetry.copilotkit.ai (SECURITY.md, "Vendor telemetry").
import { chromium } from 'playwright';

import { UPSTREAM_BOARD_URL } from '@socio/shared/updates/upstream';

import { deleteConversations, operatorUser, parseArgs, signIn as apiSignIn, testUsers } from './lib/brain-client.mjs';

const args = parseArgs(process.argv.slice(2));
// --insecure: accept a self-signed proxy certificate (homelab TLS only), in
// the browser and in the cleanup calls.
if (args.insecure === 'true') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const base = args.base ?? 'http://127.0.0.1:4310';
const scenario = args.scenario ?? 'chat';
const modelWait = Number(args['model-wait'] ?? 90_000);
// --locale sv-SE: the browser's language (Playwright's default is en-US).
const locale = args.locale;
const appOrigin = new URL(base).origin;

const foreign = new Set();
// Where the browser may go: the app's origin (and its WebSockets), and
// loopback, where the fake model, fake ChatGPT and stand-in computers
// listen. data: and blob: URLs never leave the browser.
const allowedUrl = (url) => {
    if (['data:', 'blob:', 'about:'].includes(url.protocol)) {
        return true;
    }
    const origin = url.origin.replace(/^ws(s?):/, 'http$1:');
    return (
        origin === appOrigin ||
        ['localhost', '[::1]'].includes(url.hostname) ||
        /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
    );
};
// Other hosts can't be reached at all: Chromium resolves no host name but
// the app's and localhost (loopback IPs need no lookup), so a request
// elsewhere fails before it leaves the machine. Request interception
// (context.route) would do it too, but it turns off the HTTP cache and,
// through the proxy, failed some chunk loads on reload (net::ERR_FAILED).
const resolverRules = `MAP * ~NOTFOUND, EXCLUDE ${new URL(base).hostname}, EXCLUDE localhost`;
// Fake sites a step answers itself with page.route (the ssr scenario's
// other site): never on the network, so not counted.
const fakeOrigins = new Set(['https://elsewhere.example']);
// Records every request and WebSocket a context's pages, frames and workers
// try to make to anywhere else; each one fails the run.
const guardEgress = async (context) => {
    const record = (raw) => {
        const url = new URL(raw);
        if (!allowedUrl(url) && !fakeOrigins.has(url.origin)) {
            foreign.add(url.origin.replace(/^ws(s?):/, 'http$1:'));
        }
    };
    context.on('request', (request) => record(request.url()));
    context.on('page', (tab) => tab.on('websocket', (socket) => record(socket.url())));
    return context;
};
const errors = [];
const step = (text) => console.log(`[ui-smoke] ${text}`);

// Conversations the browser created, by user id, and the socios before the run.
const created = [];
// Issues the issues scenario filed (numbers), deleted at the end.
const filedIssues = [];
// Pages the links scenario created and hasn't deleted yet (Space and page
// ids), deleted at the end if it stopped in between.
const createdPages = [];
// A console message a step expects (a request it wants refused).
let tolerated;
// The auto scenario's policy and guidance, restored at the end.
let autoRestore;
// Datasets the data scenario made (owner id, dataset id), deleted at the end.
const createdDatasets = [];
// Jobs the schedules scenario saved (owner, job id), deleted at the end.
const createdJobs = [];
// Files the media scenario's attachments left (owner, path), deleted at the end.
const createdFiles = [];
// Folders the media scenario made (owner, path), deleted with their files.
const createdFolders = [];
// The people scenario's deactivated member (an admin API and the account
// id), reactivated in the cleanup if it stopped in between.
let peopleRestore;
// The operator scenario's allowed BYO kinds before it toggled one, restored
// at the end if it stopped in between.
let byoRestore;
// The byo scenario's member, signed in to the API while connected, so the
// cleanup can disconnect if it stopped in between.
let byoConnected;
// The notifications scenario's choices before it changed them (an API
// and the map), and a push device it added: restored and removed at the
// end if it stopped in between.
let notificationsRestore;
let pushDeviceAdded;
let users;
let dotsBefore;
const browser = await chromium.launch({
    args: [`--host-resolver-rules=${resolverRules}`],
});
let failed = false;
try {
    users = await testUsers(base, args);
    const { admin, member } = users;
    step(`test users: ${admin.id} (admin), ${member.id} (member)${locale ? `; browser locale ${locale}` : ''}`);
    let current;
    const context = await guardEgress(
        await browser.newContext({
            viewport: { width: 1280, height: 860 },
            locale,
            // --insecure: accept a self-signed proxy certificate (homelab TLS).
            ignoreHTTPSErrors: args.insecure === 'true',
        }),
    );
    const page = await context.newPage();
    // Console errors and page errors fail the run, in every tab a scenario
    // opens (guardEgress covers requests).
    const watch = (tab) => {
        tab.on('console', (message) => {
            const text = message.text();
            // A server/client mismatch (entry.client.tsx's onRecoverableError):
            // always a failure, whatever a step tolerates.
            if (text.startsWith('[hydration]')) {
                errors.push(text.slice(0, 300));
                return;
            }
            // A poll answers 401 once when a session ends on the server, and a
            // link to a deleted page asks and gets 410 before saying so.
            if (/status of (401|410)/.test(text)) {
                return;
            }
            // The host's interfaces changed under Chromium (containers starting
            // and stopping on the Docker host); not the app's doing.
            if (/net::ERR_NETWORK_CHANGED/.test(text)) {
                return;
            }
            // A step that expects a refusal (the data scenario's DELETE query).
            if (tolerated?.test(text)) {
                return;
            }
            if (message.type() === 'error') {
                // A refused request names its URL: which one is the clue.
                const url = text.startsWith('Failed to load resource') ? message.location()?.url : undefined;
                errors.push(url ? `${text.slice(0, 300)} (${new URL(url).pathname})` : text.slice(0, 300));
            }
        });
        tab.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 300)}`));
    };
    watch(page);
    page.on('response', (response) => {
        const request = response.request();
        if (
            request.method() === 'POST' &&
            new URL(request.url()).pathname === '/api/conversations' &&
            response.status() === 201
        ) {
            const userId = current.id;
            created.push(response.json().then((conversation) => ({ userId, id: conversation.id })));
        }
    });
    const waitForText = (pattern, timeout = modelWait) =>
        page.waitForFunction((source) => new RegExp(source, 'i').test(document.body.innerText), pattern.source, {
            timeout,
        });

    const signIn = async (user) => {
        const name = user.name;
        const label = `Continue as ${name}`;
        // Better Auth: the email-and-password form of a test account.
        const choice = user.email
            ? page.getByRole('textbox', { name: 'Email' })
            : page.getByRole('button', { name: label });
        await choice.waitFor({ timeout: 30_000 });
        if (user.email) {
            await page.getByRole('textbox', { name: 'Email' }).fill(user.email, { timeout: 30_000 });
            await page.getByLabel('Password', { exact: true }).fill(user.password);
            await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        } else {
            await page.getByRole('button', { name: label }).click({ timeout: 30_000 });
        }
        await page.locator('[data-slot="sidebar-footer"]').getByText(name).waitFor({ timeout: 30_000 });
        current = user;
        step(`signed in as ${name}`);
    };
    // Switch user (Sign out with Better Auth) lives in the account menu at
    // the bottom of the sidebar.
    const switchUser = async () => {
        await page.getByRole('button', { name: /^Account: / }).click();
        await page.getByRole('menuitem', { name: /^(Switch user|Sign out)$/ }).click();
    };
    // A settings page (CB-95): the account menu's Account item opens
    // Settings → Account → Profile; the section nav goes on from there.
    const openSettings = async (section) => {
        await page.getByRole('button', { name: /^Account: / }).click();
        await page.getByRole('menuitem', { name: /^Account/ }).click();
        await page.waitForFunction(() => location.pathname === '/settings/account');
        await page
            .getByRole('navigation', { name: 'Settings' })
            .getByRole('link', { name: section, exact: true })
            .click();
    };
    // Recent chat titles in the sidebar, all of them (it shows the first few).
    const threadTitles = async () => {
        const more = page.getByRole('button', { name: /^Show all \d+$/ });
        if (await more.count()) {
            await more.click();
        }
        return page.locator('[data-thread-title]').allInnerTexts();
    };
    // A socio's ⋯ in the sidebar (its menu ends with All settings…).
    const dotMenus = () => page.locator('[data-dot-row] [aria-label$=" options"]');
    const openDotSettings = async () => {
        await dotMenus().first().click();
        await page.getByRole('menuitem', { name: 'All settings…' }).click();
    };
    // `/` is the launcher: a socio card's New chat opens a new chat with that
    // socio; the card's own link opens that socio's home page (CB-167).
    const openNewChat = async () => {
        const card = page.locator('[data-slot="dot-card"]').first();
        const home = await card.locator('[data-slot="dot-link"]').getAttribute('href');
        const fresh = await card.locator('[data-slot="dot-new-chat"]').getAttribute('href');
        if (!/^\/dots\/[^/]+$/.test(home ?? '') || fresh !== `${home}/new`) {
            throw new Error(`Home socio card links: ${home} and ${fresh}`);
        }
        await page.locator('[data-slot="dot-new-chat"]').first().click();
        await page.getByLabel('Start a conversation').waitFor({ timeout: 15_000 });
    };
    // The ⌘K / Ctrl+K palette: type, wait for the entry, pick it.
    const palette = () => page.getByRole('dialog', { name: 'Search Socio' });
    const paletteOpen = async (query, entry) => {
        await page.keyboard.press('ControlOrMeta+k');
        await palette().waitFor({ timeout: 5_000 });
        await palette().getByLabel('Search Socio').fill(query);
        const option = palette().getByRole('option', { name: entry }).first();
        await option.waitFor({ timeout: 10_000 });
        await option.click();
        await palette().waitFor({ state: 'detached', timeout: 5_000 });
    };
    // The home launcher's module cards, by module id.
    const launcherModules = async () => {
        await page.locator('[data-slot="module-card"]').first().waitFor({
            timeout: 15_000,
        });
        return page
            .locator('[data-slot="module-card"]')
            .evaluateAll((cards) => cards.map((card) => card.dataset.module));
    };
    // A sidebar destination: a link for routes, a button for dialogs.
    const navItem = (name, within = page.locator('[data-slot="sidebar"]')) =>
        within
            .getByRole('link', { name, exact: true })
            .or(within.getByRole('button', { name, exact: true }))
            .first();
    const header = () => page.locator('[data-slot="app-header"]');
    // What's new, from the header's Help menu (CB-308).
    // The Help menu's What's new; on a phone the header's ⋯ (More options)
    // carries the Help menu's items.
    const whatsNewFromHelp = async (tab = page) => {
        const bar = tab.locator('[data-slot="app-header"]');
        const help = bar.getByRole('button', { name: /^Help/ });
        await ((await help.isVisible()) ? help : bar.getByRole('button', { name: /^More options/ })).click();
        await tab.getByRole('menuitem', { name: /^What’s new/ }).click();
    };
    const crumbs = () => header().getByRole('navigation', { name: 'breadcrumb' });
    const pathname = () => page.evaluate(() => location.pathname);
    const waitForPath = (want, timeout = 10_000) =>
        page.waitForFunction((value) => location.pathname === value, want, {
            timeout,
        });
    // After a page load: React has hydrated the page (its nodes carry React's
    // fiber) and the browser has been idle since, so clicks reach React's
    // handlers and a mismatch is logged before the next step moves on. A
    // server-rendered page shows its text and controls before then, so
    // waiting for them alone can click dead markup or miss a mismatch. A
    // page that loads itself again meanwhile (a stale build, a failed
    // chunk) is waited for from its new document.
    const hydrated = async (tab = page) => {
        for (let attempt = 1; ; attempt++) {
            try {
                await tab.waitForFunction(
                    () => {
                        // The app's own root, not the body's first child: a popover's
                        // focus guards (the guide offer on Home) go first in the body,
                        // and a phone has no sidebar footer.
                        const node =
                            document.querySelector('[data-slot="sidebar-footer"]') ??
                            document.getElementById('root')?.firstElementChild ??
                            document.body?.firstElementChild;
                        return !!node && Object.keys(node).some((key) => key.startsWith('__reactFiber$'));
                    },
                    undefined,
                    { timeout: 15_000 },
                );
                await tab.evaluate(
                    () =>
                        new Promise((resolve) =>
                            requestIdleCallback(() => requestIdleCallback(resolve, { timeout: 1_000 }), {
                                timeout: 1_000,
                            }),
                        ),
                );
                return;
            } catch (error) {
                if (attempt >= 3 || !/context was destroyed|navigat/i.test(error)) {
                    throw error;
                }
            }
        }
    };
    // Every page load a scenario makes with JavaScript on goes through these,
    // so the next step acts on the hydrated page.
    const goto = async (url, tab = page) => {
        const response = await tab.goto(url);
        await hydrated(tab);
        return response;
    };
    const reload = async (tab = page) => {
        const response = await tab.reload();
        await hydrated(tab);
        return response;
    };
    // The theme: the account menu and the header toggle switch it, the choice
    // survives a reload and is applied before the app's code runs, and the
    // legacy view canvas follows it.
    const checkTheme = async () => {
        const theme = () =>
            page.evaluate(() => ({
                dark: document.documentElement.classList.contains('dark'),
                stored: localStorage.getItem('theme'),
                // Relative luminance of the view canvas.
                canvas: (() => {
                    const [r, g, b] = getComputedStyle(document.querySelector('[data-view-canvas]'))
                        .backgroundColor.match(/[\d.]+/g)
                        .map(Number);
                    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
                })(),
            }));
        const expectTheme = async (dark, stored) => {
            await page.waitForFunction((want) => document.documentElement.classList.contains('dark') === want, dark, {
                timeout: 5_000,
            });
            const now = await theme();
            if (now.stored !== stored || (dark ? now.canvas > 0.2 : now.canvas < 0.9)) {
                throw new Error(`Theme ${JSON.stringify(now)}, wanted dark=${dark}`);
            }
        };
        const before = await theme();
        if (before.dark || before.stored) {
            throw new Error(`Not on the light system default: ${JSON.stringify(before)}`);
        }
        await page.getByRole('button', { name: /^Account: / }).click();
        await page.getByRole('menuitem', { name: /^Theme/ }).click();
        await page.getByRole('menuitemradio', { name: 'Dark' }).click();
        await expectTheme(true, 'dark');
        await reload();
        await header().waitFor({ timeout: 30_000 });
        await expectTheme(true, 'dark');
        step('dark from the account menu, kept after a reload');
        // Before any app code: the page is dark from public/theme-init.js alone
        // (no app code, so nothing hydrates).
        const bare = await context.newPage();
        await bare.route(/\/assets\/.*\.js$/, (route) => route.abort());
        await bare.goto(base);
        const first = await bare.evaluate(() => ({
            dark: document.documentElement.classList.contains('dark'),
            scheme: getComputedStyle(document.documentElement).colorScheme,
        }));
        await bare.close();
        if (!first.dark || first.scheme !== 'dark') {
            throw new Error(`First paint not dark: ${JSON.stringify(first)}`);
        }
        step('the first paint is already dark');
        // The header's Help menu (CB-308): Light, Dark and System side by
        // side; picking one keeps the menu open.
        await header().getByRole('button', { name: /^Help/ }).click();
        await page.getByRole('menuitemradio', { name: 'Light' }).click();
        await expectTheme(false, 'light');
        await page.getByRole('menuitemradio', { name: 'System' }).click();
        await expectTheme(false, 'system');
        await page.keyboard.press('Escape');
        step('back to light, then System, from the Help menu');
    };
    // CB-66, in the chat scenario: a chat of its own, renamed from its sidebar
    // row (Enter saves, Escape keeps) and from the header, which a second tab
    // sees within a poll; right-click opens the same menu; then archived and
    // back (Undo, its link, Archived chats); then deleted from the header after
    // the confirm, landing on a new chat with its socio, and gone from both
    // tabs.
    const chatMenu = async () => {
        const api = await apiSignIn(base, admin);
        const dotId = (await api('/workspace')).dots[0].id;
        const thread = await api('/conversations', 'POST', {
            dotId,
            title: 'Smoke chat menu',
        });
        created.push({ userId: admin.id, id: thread.id });
        const other = await context.newPage();
        watch(other);
        await goto(`${base}/chats/${thread.id}`, other);
        await reload();
        const row = (tab = page) => tab.locator(`[data-chat-row="${thread.id}"]`).first();
        const rowTitle = (tab = page) => row(tab).locator('[data-thread-title]').innerText();
        const waitForRowTitle = (want, tab = page, timeout = 10_000) =>
            tab.waitForFunction(
                ([id, value]) =>
                    document.querySelector(`[data-chat-row="${id}"] [data-thread-title]`)?.textContent?.trim() ===
                    value,
                [thread.id, want],
                { timeout },
            );
        const titleBox = () => page.getByRole('textbox', { name: 'Chat title', exact: true });
        const rowRename = async () => {
            await row().hover();
            await row()
                .getByRole('button', { name: /^Options for / })
                .click();
            await page.getByRole('menuitem', { name: 'Rename' }).click();
            await titleBox().waitFor({ timeout: 5_000 });
        };
        await row().waitFor({ timeout: 15_000 });
        await rowRename();
        await titleBox().fill('Smoke renamed');
        await titleBox().press('Enter');
        await waitForRowTitle('Smoke renamed');
        const saved = (await api('/workspace')).conversations.find((item) => item.id === thread.id);
        if (saved?.title !== 'Smoke renamed' || saved.renamed !== true) {
            throw new Error(`Rename not saved: ${JSON.stringify(saved)}`);
        }
        await rowRename();
        await titleBox().fill('Not this');
        await titleBox().press('Escape');
        await titleBox().waitFor({ state: 'detached', timeout: 5_000 });
        if ((await rowTitle()) !== 'Smoke renamed') {
            throw new Error(`Escape changed the title: ${await rowTitle()}`);
        }
        step('renamed a chat from its sidebar row (Enter saves, Escape keeps)');
        await waitForRowTitle('Smoke renamed', other, 10_000);
        const otherCrumb = other.locator('[data-slot="app-header"] [data-slot="breadcrumb-page"]');
        if ((await otherCrumb.innerText()) !== 'Smoke renamed') {
            throw new Error('The other tab’s header kept the old title');
        }
        step('the other tab’s sidebar and header show the new title');
        await row().getByRole('link').click();
        await waitForPath(`/chats/${thread.id}`);
        const waitForHeaderTitle = (want) =>
            page.waitForFunction(
                (value) =>
                    document
                        .querySelector('[data-slot="app-header"] [data-slot="breadcrumb-page"]')
                        ?.textContent?.trim() === value,
                want,
                { timeout: 10_000 },
            );
        await waitForHeaderTitle('Smoke renamed');
        await header().getByRole('button', { name: 'Chat options' }).click();
        await page.getByRole('menuitem', { name: 'Rename' }).click();
        await titleBox().fill('Smoke header title');
        await titleBox().press('Enter');
        await waitForRowTitle('Smoke header title');
        await waitForHeaderTitle('Smoke header title');
        step('renamed it from the chat header; the sidebar follows');
        await row().click({ button: 'right' });
        const menu = page.locator('[data-slot="chat-menu"]');
        await menu.waitFor({ timeout: 5_000 });
        const items = await menu.getByRole('menuitem').allInnerTexts();
        if (items.join() !== 'Rename,Archive,Delete') {
            throw new Error(`Right-click menu: ${items.join(', ')}`);
        }
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'detached', timeout: 5_000 });
        step('right-click opens the same menu');
        // The other tab watches from the launcher (the tabs scenario checks a
        // tab left on the deleted chat).
        await goto(base, other);
        await row(other).waitFor({ timeout: 10_000 });
        await archiveAndBack({ api, thread, dotId, row, other });
        await header().getByRole('button', { name: 'Chat options' }).click();
        await page.getByRole('menuitem', { name: 'Delete' }).click();
        const confirm = page.getByRole('alertdialog');
        await confirm.waitFor({ timeout: 5_000 });
        const text = await confirm.innerText();
        if (!text.includes('Delete chat?') || !text.includes('This will delete “Smoke header title”.')) {
            throw new Error(`Delete confirm: ${text}`);
        }
        await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
        await waitForPath(`/dots/${dotId}/new`);
        await row().waitFor({ state: 'detached', timeout: 10_000 });
        await row(other).waitFor({ state: 'detached', timeout: 10_000 });
        if ((await api('/workspace')).conversations.some((item) => item.id === thread.id)) {
            throw new Error('The deleted chat is still listed');
        }
        step('deleted it from the header: a new chat with its socio, gone in both tabs');
        await other.close();
    };
    // In chatMenu: the open chat archived from its row (no confirm) leaves for
    // a new chat with its socio and both tabs' sidebars; the toast's Undo
    // brings it back and returns to it. Archived again from the header, its
    // link still opens it, with the notice and without a sidebar row; Account →
    // Archived chats lists it, and Unarchive there puts it back in the sidebar
    // and takes the notice away. Ends on the chat, live.
    const archiveAndBack = async ({ api, thread, dotId, row, other }) => {
        const listed = async () => {
            const shell = await api('/workspace');
            return {
                live: shell.conversations.some((item) => item.id === thread.id),
                archived: (shell.archived ?? []).some((item) => item.id === thread.id),
            };
        };
        const expectListed = async (want, what) => {
            const now = await listed();
            if (now.live !== want.live || now.archived !== want.archived) {
                throw new Error(`${what}: ${JSON.stringify(now)}`);
            }
        };
        const toast = page.locator('[data-sonner-toast]', {
            hasText: 'Chat archived',
        });
        const notice = page.locator('[data-slot="archived-chat"]');
        await row().hover();
        await row()
            .getByRole('button', { name: /^Options for / })
            .click();
        await page.getByRole('menuitem', { name: 'Archive' }).click();
        if (await page.getByRole('alertdialog').count()) {
            throw new Error('Archive asked for a confirm');
        }
        await waitForPath(`/dots/${dotId}/new`);
        await row().waitFor({ state: 'detached', timeout: 10_000 });
        await row(other).waitFor({ state: 'detached', timeout: 10_000 });
        await toast.first().waitFor({ timeout: 5_000 });
        await expectListed({ live: false, archived: true }, 'After archive');
        step('archived the open chat from its row: gone from both tabs, a toast');
        await toast.first().getByRole('button', { name: 'Undo' }).click();
        await waitForPath(`/chats/${thread.id}`);
        await row().waitFor({ timeout: 10_000 });
        await row(other).waitFor({ timeout: 10_000 });
        await expectListed({ live: true, archived: false }, 'After Undo');
        step('Undo brought it back, in both tabs, and returned to it');
        await toast.first().waitFor({ state: 'detached', timeout: 10_000 });
        await header().getByRole('button', { name: 'Chat options' }).click();
        await page.getByRole('menuitem', { name: 'Archive' }).click();
        await waitForPath(`/dots/${dotId}/new`);
        await row().waitFor({ state: 'detached', timeout: 10_000 });
        await goto(`${base}/chats/${thread.id}`);
        await notice.waitFor({ timeout: 10_000 });
        const said = await notice.innerText();
        if (!said.includes('This chat is archived.')) {
            throw new Error(`Archived notice: ${said}`);
        }
        if (await row().count()) {
            throw new Error('The archived chat has a sidebar row');
        }
        await header().getByRole('button', { name: 'Chat options' }).click();
        const headerItems = await page.locator('[data-slot="chat-menu"]').getByRole('menuitem').allInnerTexts();
        if (headerItems.join() !== 'Rename,Unarchive,Delete') {
            throw new Error(`Archived chat's menu: ${headerItems.join(', ')}`);
        }
        await page.keyboard.press('Escape');
        step('archived again from the header; its link opens it, with the notice');
        // Settings → Account → Archived chats (a page since CB-95).
        await openSettings('Archived chats');
        const section = page.locator('[data-slot="archived-chats-section"]');
        await section.waitFor({ timeout: 10_000 });
        await section.getByRole('button', { name: 'Manage' }).click();
        const list = page.locator('[data-slot="archived-chats"]');
        await list.waitFor({ timeout: 5_000 });
        const entry = list.locator(`[data-archived-chat="${thread.id}"]`);
        await entry.waitFor({ timeout: 5_000 });
        await entry.getByRole('button', { name: /^Unarchive / }).click();
        await entry.waitFor({ state: 'detached', timeout: 10_000 });
        await notice.waitFor({ state: 'detached', timeout: 10_000 });
        await row().waitFor({ timeout: 10_000 });
        await expectListed({ live: true, archived: false }, 'After Unarchive');
        // The list closes; the chat is live again in the sidebar, and opens
        // from its link as before.
        await page.keyboard.press('Escape');
        await list.waitFor({ state: 'detached', timeout: 5_000 });
        await row(other).waitFor({ timeout: 10_000 });
        await goto(`${base}/chats/${encodeURIComponent(thread.id)}`);
        await header().getByRole('button', { name: 'Chat options' }).waitFor({ timeout: 15_000 });
        step('found it in Account → Archived chats and unarchived it there');
    };
    // CB-73, in the chat scenario: a Telegram team topic opens with no toast
    // and no refused request, for alice and for bob. Nobody owns a topic, so
    // the chat view must not ask for an owner's route (the capture poll did,
    // and its 404 showed "Conversation not found."). Topics come from
    // Telegram; on a local server, tests/fixtures/seed-team-topic.ts makes
    // one. Skipped for a user whose workspace lists none.
    const teamTopic = async (user) => {
        const api = await apiSignIn(base, user);
        const topic = (await api('/workspace')).conversations.find((item) => item.team);
        if (!topic) {
            step(`${user.name} is in no team topic: team topic check skipped`);
            return;
        }
        const refused = [];
        const onResponse = (response) => {
            const { pathname } = new URL(response.url());
            if (pathname.startsWith('/api/') && response.status() >= 400) {
                refused.push(`${response.status()} ${pathname}`);
            }
        };
        const before = errors.length;
        page.on('response', onResponse);
        try {
            await goto(`${base}/chats/${topic.id}`);
            await page
                .getByText('Reply in the Telegram topic to continue this conversation.')
                .waitFor({ timeout: 15_000 });
            // Past two capture polls (3 s) and a transcript poll (5 s).
            await page.waitForTimeout(7_000);
        } finally {
            page.off('response', onResponse);
        }
        const toasts = await page.locator('[data-sonner-toast]').allInnerTexts();
        if (toasts.length) {
            throw new Error(`Team topic toast: ${toasts.join(' | ')}`);
        }
        if (refused.length) {
            throw new Error(`Team topic requests refused: ${refused.join(', ')}`);
        }
        if (errors.length > before) {
            throw new Error(`Team topic console: ${errors.slice(before).join(' | ')}`);
        }
        if (await header().getByRole('button', { name: 'Chat options' }).count()) {
            throw new Error('A team topic offers the chat menu');
        }
        step(`${user.name} opened team topic ${topic.id}: no toast, nothing refused`);
    };
    // CB-74, in the tabs scenario: the same chat open in both tabs. Tab A
    // sends; tab B shows the message and the socio's reply without a reload
    // (it has no poll of its own: only the note brings them). Tab B's
    // catch-up posts no note back, so tab A asks nothing more about the
    // chat afterwards. Needs a model; the scripted fake answers at once.
    const tabChat = async (other, threadId, notReloaded) => {
        const api = await apiSignIn(base, admin);
        if (!(await api('/workspace')).setup.model) {
            step('no model: the chat across tabs skipped');
            return;
        }
        await goto(`${base}/chats/${threadId}`);
        for (const tab of [page, other]) {
            await tab.getByText('Here with you', { exact: true }).waitFor({ timeout: 30_000 });
        }
        const word = `tabsync${Date.now().toString(36)}`;
        const prompt = `Reply with exactly the word: ${word}`;
        const reply = (tab) => tab.locator('[data-chat-message="assistant"]').filter({ hasText: word }).first();
        const asked = [];
        const watchA = (request) => {
            const { pathname } = new URL(request.url());
            if (pathname === `/api/conversations/${threadId}/transcript` || pathname.startsWith('/api/copilotkit')) {
                asked.push({ pathname, at: Date.now() });
            }
        };
        await page.getByLabel('Message your socio').fill(prompt);
        await page.getByLabel('Send message').click();
        await reply(page).waitFor({ timeout: 60_000 });
        await page.getByLabel('Send message').waitFor({ state: 'attached', timeout: 30_000 });
        const repliedAt = Date.now();
        await reply(other).waitFor({ timeout: 10_000 });
        const followed = Date.now() - repliedAt;
        const mine = other.locator('[data-chat-message="user"]').filter({ hasText: prompt });
        if (!(await mine.count())) {
            throw new Error('Tab B shows the reply without the message sent');
        }
        // No poll brings them: a second and a half is the note.
        if (followed > 1500) {
            throw new Error(`Tab B showed tab A's turn after ${followed} ms`);
        }
        await notReloaded();
        // No ping-pong: tab B's catch-up tells tab A nothing.
        page.on('request', watchA);
        await page.waitForTimeout(3000);
        page.off('request', watchA);
        if (asked.length) {
            throw new Error(`After tab B caught up, tab A asked ${asked.map((item) => item.pathname).join(', ')}`);
        }
        step(
            `sent in tab A: tab B shows the message and the reply in ${followed} ms, without a reload; tab A asked nothing after`,
        );
    };
    // CB-74, in the tabs scenario: writes reach the other tab over the
    // changes channel, well before its poll, and a tab that comes back after
    // a while re-reads what it shows. Tab A renames a chat that tab B has
    // open; then deletes it, and tab B leaves it with no console 404 (the
    // capture poll never asks for it); then tab B, on a page whose data is
    // its loader's (Media), is hidden and shown again: a short absence asks
    // nothing, a longer one revalidates the page once and re-reads the shell.
    const tabWrites = async (other, notReloaded) => {
        const api = await apiSignIn(base, admin);
        const dotId = (await api('/workspace')).dots[0].id;
        const thread = await api('/conversations', 'POST', {
            dotId,
            title: 'Smoke tabs chat',
        });
        created.push({ userId: admin.id, id: thread.id });
        // Tab B opens the chat (a load), then must not reload again.
        const mark = () =>
            other.evaluate(() => {
                globalThis.smokeTab = 'kept';
            });
        await goto(`${base}/chats/${thread.id}`, other);
        await mark();
        await tabChat(other, thread.id, notReloaded);
        await goto(base);
        const row = (tab) => tab.locator(`[data-chat-row="${thread.id}"]`).first();
        await row(page).waitFor({ timeout: 15_000 });
        const openMenu = async () => {
            await row(page).hover();
            await row(page)
                .getByRole('button', { name: /^Options for / })
                .click();
        };
        await openMenu();
        await page.getByRole('menuitem', { name: 'Rename' }).click();
        const titleBox = page.getByRole('textbox', {
            name: 'Chat title',
            exact: true,
        });
        await titleBox.fill('Smoke tabs renamed');
        const saved = page.waitForResponse(
            (response) =>
                response.request().method() === 'PATCH' &&
                new URL(response.url()).pathname === `/api/conversations/${thread.id}`,
        );
        await titleBox.press('Enter');
        await saved;
        const renamedAt = Date.now();
        await other.waitForFunction(
            (value) =>
                document
                    .querySelector('[data-slot="app-header"] [data-slot="breadcrumb-page"]')
                    ?.textContent?.trim() === value,
            'Smoke tabs renamed',
            { timeout: 10_000 },
        );
        const renameFollowed = Date.now() - renamedAt;
        // The shell polls every 3 s: a second is a note, not the poll.
        if (renameFollowed > 1500) {
            throw new Error(`Tab B saw the rename after ${renameFollowed} ms`);
        }
        step(`renamed a chat in tab A: tab B's header shows it in ${renameFollowed} ms`);
        const captures = [];
        const watchCaptures = (request) => {
            if (new URL(request.url()).pathname === `/api/conversations/${thread.id}/capture`) {
                captures.push(Date.now());
            }
        };
        other.on('request', watchCaptures);
        await openMenu();
        await page.getByRole('menuitem', { name: 'Delete' }).click();
        const confirm = page.getByRole('alertdialog');
        await confirm.waitFor({ timeout: 5_000 });
        const deleted = page.waitForResponse(
            (response) =>
                response.request().method() === 'DELETE' &&
                new URL(response.url()).pathname === `/api/conversations/${thread.id}`,
        );
        await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
        await deleted;
        const deletedAt = Date.now();
        await other.getByText('Conversation not found.').waitFor({ timeout: 10_000 });
        const left = Date.now() - deletedAt;
        if (left > 1500) {
            throw new Error(`Tab B left the deleted chat after ${left} ms`);
        }
        // Two capture polls' worth: none asks for the deleted chat.
        await other.waitForTimeout(6500);
        other.off('request', watchCaptures);
        const late = captures.filter((at) => at >= deletedAt);
        if (late.length) {
            throw new Error(`Tab B asked for the deleted chat's capture ${late.length} times`);
        }
        await notReloaded();
        step(`deleted it in tab A: tab B left it in ${left} ms, and never asked for it again (no 404)`);
        // Back into view: Media's data is its loader's alone, so a return
        // revalidates it (a `.data` request); the shell is its poll's.
        await goto(`${base}/media`, other);
        await mark();
        await other.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => (globalThis.smokeHidden ? 'hidden' : 'visible'),
            });
        });
        const away = async (ms) => {
            await other.evaluate(() => {
                globalThis.smokeHidden = true;
                document.dispatchEvent(new Event('visibilitychange'));
            });
            await other.waitForTimeout(ms);
            const shownAt = Date.now();
            await other.evaluate(() => {
                globalThis.smokeHidden = false;
                document.dispatchEvent(new Event('visibilitychange'));
                window.dispatchEvent(new FocusEvent('focus'));
            });
            return shownAt;
        };
        const asked = [];
        const record = (request) => {
            const { pathname } = new URL(request.url());
            if (pathname.endsWith('.data') || pathname === '/api/state') {
                asked.push({ pathname, at: Date.now() });
            }
        };
        other.on('request', record);
        const quick = await away(500);
        await other.waitForTimeout(1000);
        const quickData = asked.filter((item) => item.at >= quick && item.pathname.endsWith('.data'));
        if (quickData.length) {
            throw new Error('A half-second absence revalidated the page');
        }
        const back = await away(2500);
        await other.waitForTimeout(1500);
        const since = asked.filter((item) => item.at >= back);
        const data = since.filter((item) => item.pathname.endsWith('.data'));
        const state = since.filter((item) => item.pathname === '/api/state');
        other.off('request', record);
        await other.evaluate(() => {
            Reflect.deleteProperty(document, 'visibilityState');
            delete globalThis.smokeHidden;
        });
        if (data.length !== 1) {
            throw new Error(`Back after 2.5 s, tab B revalidated ${data.length} times (want 1)`);
        }
        if (!state.length || state[0].at - back > 1000) {
            throw new Error('Back after 2.5 s, tab B did not re-read the shell');
        }
        if (data[0].pathname !== '/media.data') {
            throw new Error(`Revalidated ${data[0].pathname}, not the Media page`);
        }
        await notReloaded();
        step(
            `tab B back after 0.5 s: nothing; after 2.5 s: the shell in ${state[0].at - back} ms and one revalidation (${data[0].pathname})`,
        );
    };
    // The chat scenario's transcript and composer checks (CB-66), with the
    // scripted fake model only (its "smoke …" turns): Copy under a reply,
    // the status line's size and text, following and "Scroll to end", and
    // the composer's approval bar. Any other model skips them.
    const transcriptChecks = async () => {
        const transcript = page.locator('[data-chat-transcript]');
        if (!/from the fake model/.test(await transcript.innerText())) {
            step('not the scripted fake model: transcript checks skipped');
            return;
        }
        const box = page.getByLabel('Message your socio');
        const sendText = async (text) => {
            await box.fill(text);
            await page.getByLabel('Send message').click();
        };
        // Copy: the reply's Markdown source, a check mark, "Copied".
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: appOrigin,
        });
        const reply = page
            .locator('[data-chat-message="assistant"]')
            .filter({ hasText: 'pelican, from the fake model.' })
            .last();
        await reply.hover();
        const actions = reply.locator('[data-slot="message-actions"]');
        // Shown on hover (after a short fade).
        await actions.evaluate(
            (row) =>
                new Promise((resolve, reject) => {
                    const until = Date.now() + 2_000;
                    const check = () =>
                        getComputedStyle(row).opacity === '1'
                            ? resolve()
                            : Date.now() > until
                              ? reject(new Error('The action row did not show on hover'))
                              : requestAnimationFrame(check);
                    check();
                }),
        );
        await actions.getByRole('button', { name: 'Copy' }).click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        if (copied !== 'pelican, from the fake model.') {
            throw new Error(`Copy put ${JSON.stringify(copied)} on the clipboard`);
        }
        await actions.locator('svg.lucide-check').waitFor({ timeout: 1_000 });
        await actions.getByRole('status').getByText('Copied').waitFor();
        await actions.locator('svg.lucide-copy').waitFor({ timeout: 4_000 });
        step('Copy put the reply’s Markdown on the clipboard, with a check mark');
        // No text on the chat page is below 10 px any more (it was 9 px).
        const tiny = await page.evaluate(() =>
            [...document.querySelectorAll('body *')]
                .filter(
                    (element) =>
                        [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()) &&
                        element.getClientRects().length &&
                        parseFloat(getComputedStyle(element).fontSize) < 10,
                )
                .map((element) => element.textContent.trim().slice(0, 40)),
        );
        if (tiny.length) {
            throw new Error(`Text below 10 px: ${tiny.join(' | ')}`);
        }
        // The status line: one readable line, the header says nothing of it.
        await sendText('smoke wait, please');
        const line = page.locator('[data-slot="run-phase"]');
        await line.waitFor({ timeout: 10_000 });
        await page.waitForTimeout(2_200);
        const status = await line.evaluate((element) => ({
            text: element.innerText,
            size: parseFloat(getComputedStyle(element).fontSize),
        }));
        if (status.size < 12 || !/^Waiting for .+ · \d+ s$/.test(status.text)) {
            throw new Error(`Status line: ${JSON.stringify(status)}`);
        }
        if (/Thinking…/.test(await page.locator('[data-slot="chat-header"]').first().innerText())) {
            throw new Error('The header says Thinking…');
        }
        step(`status line "${status.text}" at ${status.size} px`);
        await page.getByLabel('Stop response').click();
        await line.waitFor({ state: 'detached', timeout: 15_000 });
        // Following: a transcript taller than the screen; up stops following
        // and shows "Scroll to end"; the button and sending go to the end.
        const toEnd = page.getByRole('button', { name: 'Scroll to end' });
        const atEnd = () =>
            transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight <= 80);
        for (const n of [1, 2]) {
            await sendText(`smoke long, please (${n})`);
            await page.waitForFunction(
                (count) => (document.body.innerText.match(/end of the long answer/g) ?? []).length >= count,
                n,
                { timeout: 30_000 },
            );
        }
        await page.waitForTimeout(500);
        if (!(await atEnd()) || (await toEnd.count())) {
            throw new Error('Not at the end after the answers');
        }
        await transcript.hover();
        await page.mouse.wheel(0, -1_500);
        await toEnd.waitFor({ timeout: 5_000 });
        await toEnd.click();
        await toEnd.waitFor({ state: 'detached', timeout: 5_000 });
        if (!(await atEnd())) {
            throw new Error('Scroll to end did not reach it');
        }
        step('scrolled up: "Scroll to end" showed, and took the reader back');
        await transcript.hover();
        await page.mouse.wheel(0, -1_500);
        await toEnd.waitFor({ timeout: 5_000 });
        await sendText('smoke stream, please');
        await page.waitForTimeout(1_500);
        if (!(await atEnd()) || (await toEnd.count())) {
            throw new Error('Sending did not jump to the end and follow');
        }
        await page.waitForTimeout(1_500);
        if (!(await atEnd())) {
            throw new Error('The stream was not followed');
        }
        // The wheel over the transcript (Send moved the pointer away).
        await transcript.hover();
        await page.mouse.wheel(0, -1_200);
        // The wheel scrolls smoothly: measure once it has settled.
        await page.waitForTimeout(500);
        const top = await transcript.evaluate((element) => element.scrollTop);
        await page.waitForTimeout(1_500);
        const later = await transcript.evaluate((element) => element.scrollTop);
        if (Math.abs(later - top) > 2 || !(await toEnd.count())) {
            throw new Error(
                `A growing reply pulled the reader back down (${top} → ${later}, button ${await toEnd.count()})`,
            );
        }
        await waitForText(/Paragraph 20\.[\s\S]*end of the long answer/);
        step('sending jumped to the end; the stream was followed until the reader scrolled up');
        // The approval bar: two requests, the oldest first; the text box keeps
        // its draft; Approve acts on the oldest; a decision made elsewhere
        // (here the API) lifts the bar.
        await sendText('Smoke approvals, please: two datasets.');
        const bar = page.locator('[data-slot="approval-bar"]');
        await bar.waitFor({ timeout: 30_000 });
        await bar.getByText('1 of 2').waitFor({ timeout: 10_000 });
        await bar.getByText(/asks to create datasets/).waitFor();
        await bar.getByText(/Smoke first/).waitFor();
        await box.fill('A draft while the socio waits');
        await bar.getByRole('button', { name: 'Show request' }).click();
        const first = page.locator(`[data-approval-id="${await bar.getAttribute('data-approval')}"]`);
        await page.waitForFunction(
            (id) => document.querySelector(`[data-approval-id="${id}"]`)?.dataset.highlight === 'true',
            await bar.getAttribute('data-approval'),
            { timeout: 2_000 },
        );
        if (!(await first.isVisible())) {
            throw new Error('Show request: no card');
        }
        await bar.getByRole('button', { name: 'Approve' }).click();
        await first.getByText(/Created dataset “Smoke first”/).waitFor({ timeout: 15_000 });
        await bar.getByText(/Smoke second/).waitFor({ timeout: 10_000 });
        if (await bar.getByText('1 of 2').count()) {
            throw new Error('Still "1 of 2" after deciding one');
        }
        const api = await apiSignIn(base, admin);
        for (const dataset of (await api('/data')).datasets) {
            if (dataset.access === 'owner' && dataset.name === 'Smoke first') {
                createdDatasets.push([admin, dataset.id]);
            }
        }
        await api(`/approvals/${encodeURIComponent(await bar.getAttribute('data-approval'))}/decision`, 'POST', {
            decision: 'deny',
        });
        await bar.waitFor({ state: 'detached', timeout: 15_000 });
        if ((await box.inputValue()) !== 'A draft while the socio waits') {
            throw new Error('The draft was lost');
        }
        await box.fill('');
        step('approval bar: 1 of 2, Show request, Approve; lifted when denied elsewhere; the draft kept');
    };
    const scenarios = {
        async operations() {
            const memberApi = await apiSignIn(base, member);
            for (const path of [
                '/operations/overview',
                '/operations/settings',
                '/operations/reliability',
                '/operations/reliability/failures',
            ]) {
                await memberApi(path).then(
                    () => {
                        throw new Error(`${path} answered a member`);
                    },
                    (error) => {
                        if (!/: 403 /.test(error.message)) {
                            throw error;
                        }
                    },
                );
            }
            step('a member gets 403 from /api/operations/*');
            await goto(base);
            await signIn(member);
            if (await navItem('Operations').count()) {
                throw new Error('A member sees Operations in the sidebar');
            }
            await goto(`${base}/operations`);
            await waitForPath('/');
            step('a member is sent home from /operations');
            await switchUser();
            await signIn(admin);
            await navItem('Operations').click();
            await waitForPath('/operations');
            await page.getByRole('heading', { name: 'Overview' }).waitFor();
            const tiles = page.locator('[data-slot="ops-tile"]');
            await tiles.nth(5).waitFor({ timeout: 15_000 });
            const range = page.getByRole('group', { name: 'Range' });
            const pressed = () => range.locator('[aria-pressed="true"]').allInnerTexts();
            if ((await pressed()).join() !== '7d') {
                throw new Error(`The range starts at ${await pressed()}`);
            }
            const zone = await page.locator('[data-slot="ops-time-zone"]').innerText();
            step(`Overview: ${await tiles.count()} tiles, 7 days, ${zone}`);
            await range.getByRole('button', { name: '30d' }).click();
            await page.waitForFunction(() => location.search === '?range=30d');
            // A filter as a drill-down link would set it.
            const { dots } = await (await apiSignIn(base, admin))('/workspace');
            const socio = dots[0];
            await goto(`${base}/operations?range=30d&socio=${socio.id}`);
            await reload();
            if ((await pressed()).join() !== '30d') {
                throw new Error('The range was lost on reload');
            }
            await page.locator('[data-slot="ops-filter"]').getByText(`Socio: ${socio.name}`).waitFor();
            step('range and filter come back from the address after a reload');
            const shots = args.shots;
            const shot = async (name) => {
                if (!shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(shots, { recursive: true });
                for (const theme of ['light', 'dark']) {
                    await page.evaluate((value) => {
                        document.documentElement.classList.toggle('dark', value === 'dark');
                    }, theme);
                    await page.waitForTimeout(400);
                    await page.screenshot({
                        path: `${shots}/${name}-${theme}.png`,
                        fullPage: true,
                    });
                    step(`screenshot ${name}-${theme}.png`);
                }
                await page.evaluate(() =>
                    document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark'),
                );
            };
            await page.setViewportSize({ width: 1440, height: 900 });
            await shot('operations-1440');
            const nav = page.getByRole('navigation', { name: 'Operations' });
            await nav.getByRole('link', { name: 'Reliability' }).click();
            await page.waitForFunction(
                (id) => location.pathname === '/operations/reliability' && location.search === `?range=30d&socio=${id}`,
                socio.id,
            );
            step('the section nav keeps the range and filter');
            // Reliability (CB-189): its totals, the categories and the failures.
            await page.getByRole('heading', { name: 'Reliability' }).waitFor();
            await tiles.nth(5).waitFor({ timeout: 15_000 });
            await page.locator('[data-slot="ops-failures"]').waitFor();
            await page.locator('[data-slot="ops-issues"]').waitFor();
            step(`Reliability: ${await tiles.count()} tiles, failures and the board`);
            await shot('operations-reliability-1440');
            await page.getByRole('button', { name: `Clear Socio: ${socio.name}` }).click();
            await page.waitForFunction(() => location.search === '?range=30d');
            await page.goBack();
            await page.waitForFunction((id) => location.search.endsWith(id), socio.id);
            step('a filter clears, and Back brings it back');
            await nav.getByRole('link', { name: 'Settings' }).click();
            await waitForPath('/operations/settings');
            await page.locator('[data-slot="ops-time-zone-setting"] input').waitFor();
            await shot('operations-settings-1440');
            await page.setViewportSize({ width: 390, height: 844 });
            await goto(`${base}/operations?range=30d`);
            await tiles.nth(5).waitFor({ timeout: 15_000 });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
            if (overflow > 1) {
                throw new Error(`Overview is ${overflow} px wider than a phone`);
            }
            await shot('operations-390');
            await goto(`${base}/operations/settings`);
            await page.locator('[data-slot="ops-time-zone-setting"] input').waitFor();
            await shot('operations-settings-390');
            await goto(`${base}/operations/reliability?range=30d`);
            await page.locator('[data-slot="ops-failures"]').waitFor();
            await tiles.nth(5).waitFor({ timeout: 15_000 });
            const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
            if (wide > 1) {
                throw new Error(`Reliability is ${wide} px wider than a phone`);
            }
            await shot('operations-reliability-390');
            step('Overview and Reliability fit a 390 px phone');
            // Health (CB-192): backups and freshness are live, the rest from
            // analytics; both fit a phone.
            await goto(`${base}/operations/health?range=30d`);
            await page.locator('[data-slot="ops-health-freshness"] li').first().waitFor({ timeout: 15_000 });
            const healthOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
            if (healthOverflow > 1) {
                throw new Error(`Health is ${healthOverflow} px wider than a phone`);
            }
            await shot('operations-health-390');
            await page.setViewportSize({ width: 1440, height: 900 });
            await reload();
            await page.locator('[data-slot="ops-health-freshness"] li').first().waitFor({ timeout: 15_000 });
            await shot('operations-health-1440');
            await page.setViewportSize({ width: 1280, height: 860 });
            step('Health shows backups and freshness, and fits a 390 px phone');
        },
        async 'operations-access'() {
            // A chat with turns, when the server has one (--chat-id, such as
            // seed-long-chat.ts makes); else a new, empty one of bob's (bob is a
            // member), which needs a model set up. alice reads it as an admin.
            const memberApi = await apiSignIn(base, member);
            const seeded = args['chat-id'];
            let chatId = seeded;
            if (!chatId) {
                const { dots } = await memberApi('/workspace');
                const thread = await memberApi('/conversations', 'POST', {
                    dotId: dots[0].id,
                    title: 'Smoke access log',
                });
                created.push({ userId: member.id, id: thread.id });
                chatId = thread.id;
            }
            for (const path of [
                `/operations/chats/${chatId}`,
                `/operations/chats/${chatId}/history`,
                '/operations/access-log',
            ]) {
                await memberApi(path).then(
                    () => {
                        throw new Error(`${path} answered a member`);
                    },
                    (error) => {
                        if (!/: 403 /.test(error.message)) {
                            throw error;
                        }
                    },
                );
            }
            step('a member gets 403 from the transcript and the access log');
            await goto(base);
            await signIn(admin);
            const shots = args.shots;
            const shot = async (name) => {
                if (!shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(shots, { recursive: true });
                for (const theme of ['light', 'dark']) {
                    await page.evaluate((value) => {
                        document.documentElement.classList.toggle('dark', value === 'dark');
                    }, theme);
                    await page.waitForTimeout(400);
                    await page.screenshot({
                        path: `${shots}/${name}-${theme}.png`,
                        fullPage: true,
                    });
                    step(`screenshot ${name}-${theme}.png`);
                }
                await page.evaluate(() =>
                    document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark'),
                );
            };
            await page.setViewportSize({ width: 1440, height: 900 });
            if (seeded) {
                // From Overview's list of turns, once analytics has them.
                await goto(`${base}/operations?range=30d`);
                const open = page.locator(`[data-slot="ops-turn"] a[href*="/chats/${chatId}?"]`).first();
                await open.waitFor({ timeout: 60_000 });
                await open.scrollIntoViewIfNeeded();
                await shot('overview-turns-1440');
                await open.click();
                await waitForPath(`/operations/chats/${chatId}`);
                step('Overview’s turn opens its chat');
            } else {
                await goto(`${base}/operations/chats/${chatId}?via=overview`);
            }
            await page.locator('[data-slot="ops-transcript-note"]').waitFor();
            // The chat's title replaces "Chat" once its heading is in.
            await page.waitForFunction(() => document.querySelector('h1')?.textContent !== 'Chat');
            const view = { title: await page.locator('h1').innerText() };
            const transcript = page.locator('[data-slot="ops-transcript"]');
            if (seeded) {
                await transcript.locator('[data-chat-message="assistant"]').first().waitFor({ timeout: 15_000 });
            } else {
                await transcript.getByText('No finished turns').waitFor();
            }
            if (await page.locator('textarea').count()) {
                throw new Error('The admin transcript has a composer');
            }
            step(`transcript of "${view.title}", read-only`);
            const fits = async (what) => {
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
                if (overflow > 1) {
                    throw new Error(`${what} is ${overflow} px wider than a phone`);
                }
            };
            await page.setViewportSize({ width: 1440, height: 900 });
            await shot('transcript-1440');
            await page.locator('[data-slot="ops-transcript-note"]').getByRole('link', { name: 'access log' }).click();
            await waitForPath('/operations/access-log');
            const first = page.locator('[data-slot="ops-access-entry"]').first();
            await first.waitFor({ timeout: 10_000 });
            const text = await first.innerText();
            if (!text.includes('Chat transcript') || !text.includes(view.title) || !text.includes('from Overview')) {
                throw new Error(`The newest entry is "${text}"`);
            }
            step(`the access log has the open first: ${text.replace(/\s+/g, ' ')}`);
            await shot('access-log-1440');
            await page.setViewportSize({ width: 390, height: 844 });
            await goto(`${base}/operations/access-log`);
            await first.waitFor({ timeout: 10_000 });
            await fits('The access log');
            await shot('access-log-390');
            await goto(`${base}/operations/chats/${chatId}?via=access-log`);
            await page.locator('[data-slot="ops-transcript-note"]').waitFor();
            if (seeded) {
                await transcript.locator('[data-chat-message="assistant"]').first().waitFor({ timeout: 15_000 });
            }
            await fits('The transcript');
            await shot('transcript-390');
            await page.setViewportSize({ width: 1280, height: 860 });
            step('the access log and the transcript fit a 390 px phone');
        },
        async 'ops-activity'() {
            await goto(base);
            await signIn(admin);
            const shots = args.shots;
            // Each page from its top, then its lists (the page scrolls inside).
            const shot = async (name, at = 'top') => {
                if (!shots) {
                    return;
                }
                if (at === 'top') {
                    await page.evaluate(() => {
                        for (const element of document.querySelectorAll('*')) {
                            if (element.scrollTop) {
                                element.scrollTop = 0;
                            }
                        }
                    });
                } else {
                    await page.locator(at).scrollIntoViewIfNeeded();
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(shots, { recursive: true });
                for (const theme of ['light', 'dark']) {
                    await page.evaluate((value) => {
                        document.documentElement.classList.toggle('dark', value === 'dark');
                    }, theme);
                    await page.waitForTimeout(400);
                    await page.screenshot({
                        path: `${shots}/${name}-${theme}.png`,
                        fullPage: true,
                    });
                    step(`screenshot ${name}-${theme}.png`);
                }
                await page.evaluate(() =>
                    document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark'),
                );
            };
            const tiles = page.locator('[data-slot="ops-tile"]');
            const fits = async (what) => {
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
                if (overflow > 1) {
                    throw new Error(`${what} is ${overflow} px wider than a phone`);
                }
            };
            for (const width of [1440, 390]) {
                await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
                await goto(`${base}/operations/activity?range=30d`);
                await page.getByRole('heading', { name: 'Activity' }).waitFor();
                await tiles.nth(5).waitFor({ timeout: 15_000 });
                await page.locator('[data-slot="ops-activity-lists"]').waitFor();
                if (width === 1440) {
                    const person = page.locator('[data-slot="ops-person"] a').first();
                    if (await person.count()) {
                        await person.click();
                        await page.waitForFunction(() => /[?&]person=/.test(location.search));
                        await tiles.nth(5).waitFor();
                        step('a person’s name narrows Activity to them');
                        await page.goBack();
                    }
                    step(`Activity: ${await tiles.count()} tiles and its lists`);
                } else {
                    await fits('Activity');
                }
                await shot(`ops-activity-${width}`);
                await shot(`ops-activity-lists-${width}`, '[data-slot="ops-activity-lists"]');
                await goto(`${base}/operations/value?range=30d`);
                await page.getByRole('heading', { name: 'Value' }).waitFor();
                await tiles.nth(4).waitFor({ timeout: 15_000 });
                await page.locator('[data-slot="ops-outcomes"]').waitFor();
                await page.getByRole('tab', { name: 'Sessions' }).click();
                if (width === 1440) {
                    step('Value: five tiles, outcomes and sessions');
                } else {
                    await fits('Value');
                }
                await shot(`ops-value-${width}`);
                await shot(`ops-value-lists-${width}`, '[data-slot="ops-value-lists"]');
                // Themes (CB-199): intents, themes and the review.
                await goto(`${base}/operations/themes?range=30d`);
                await page.getByRole('heading', { name: 'Themes' }).waitFor();
                await page.locator('[data-slot="ops-themes"]').waitFor();
                await page.locator('[data-slot="ops-session-review"]').waitFor();
                if (width === 1440) {
                    step('Themes: intents, themes and the review');
                } else {
                    await fits('Themes');
                }
                await shot(`ops-themes-${width}`);
                await goto(`${base}/operations/settings`);
                await page.locator('[data-slot="ops-session-gap-setting"] input').waitFor();
                await shot(`ops-settings-${width}`);
            }
            await page.setViewportSize({ width: 1280, height: 860 });
            step('Activity, Value and Themes fit a 390 px phone');
        },
        async 'operations-knowledge'() {
            const memberApi = await apiSignIn(base, member);
            for (const path of ['/operations/knowledge', '/operations/storage', '/operations/capabilities']) {
                await memberApi(path).then(
                    () => {
                        throw new Error(`${path} answered a member`);
                    },
                    (error) => {
                        if (!/: 403 /.test(error.message)) {
                            throw error;
                        }
                    },
                );
            }
            step('a member gets 403 from Knowledge, storage and Capabilities');
            const adminApi = await apiSignIn(base, admin);
            const storage = await adminApi('/operations/storage?range=30d');
            if (storage.quotas.length !== 4) {
                throw new Error(`${storage.quotas.length} limits, not 4`);
            }
            const { coverage } = await adminApi('/operations/capabilities');
            const lost = coverage.tools.filter((tool) => tool.offered && !tool.module);
            if (lost.length) {
                throw new Error(`Tools without a module: ${lost.map((t) => t.name)}`);
            }
            step(`limits in force; ${coverage.tools.length} tools, ${coverage.unregistered.length} without an entry`);
            await goto(base);
            await signIn(admin);
            const shots = args.shots;
            const shot = async (name) => {
                if (!shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(shots, { recursive: true });
                for (const theme of ['light', 'dark']) {
                    await page.evaluate((value) => {
                        document.documentElement.classList.toggle('dark', value === 'dark');
                    }, theme);
                    await page.waitForTimeout(400);
                    await page.screenshot({
                        path: `${shots}/${name}-${theme}.png`,
                        fullPage: true,
                    });
                    step(`screenshot ${name}-${theme}.png`);
                }
                await page.evaluate(() =>
                    document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark'),
                );
            };
            const open = async (path, heading, ready) => {
                await goto(`${base}${path}`);
                await page.getByRole('heading', { name: heading }).waitFor();
                await page.locator(ready).first().waitFor({ timeout: 15_000 });
                // The layout clips, so the page never scrolls sideways: check the
                // tiles and cards themselves end inside the screen.
                const overflow = await page.evaluate(() =>
                    Math.max(
                        document.documentElement.scrollWidth - innerWidth,
                        ...[...document.querySelectorAll('[data-slot="ops-tile"], [data-slot="card"]')].map(
                            (element) => element.getBoundingClientRect().right - innerWidth,
                        ),
                    ),
                );
                if (overflow > 1) {
                    throw new Error(`${heading} is ${overflow} px too wide`);
                }
            };
            for (const [width, height] of [
                [1440, 900],
                [390, 844],
            ]) {
                await page.setViewportSize({ width, height });
                await open('/operations/knowledge?range=30d', 'Knowledge', '[data-slot="ops-quotas-table"]');
                await shot(`operations-knowledge-${width}`);
                await open('/operations/capabilities?range=30d', 'Capabilities', '[data-slot="ops-coverage-table"]');
                await shot(`operations-capabilities-${width}`);
            }
            await page.setViewportSize({ width: 1280, height: 860 });
            step('Knowledge and Capabilities open, and fit a 390 px phone');
        },
        async releases() {
            const signedOut = await fetch(`${base}/api/releases`);
            if (signedOut.status !== 401) {
                throw new Error(`/api/releases answered ${signedOut.status} signed out`);
            }
            const health = await (await fetch(`${base}/healthz`)).json();
            const api = await apiSignIn(base, member);
            const listed = await api('/releases');
            if (health.version !== listed.current) {
                throw new Error(`/healthz says ${health.version}, /api/releases ${listed.current}`);
            }
            step(`the app is v${listed.current} (${listed.commit ?? 'no commit'})`);
            if (listed.releases.length < 2) {
                throw new Error('The release notes list fewer than two releases');
            }
            const tags = listed.releases.map((release) => release.tag);
            await goto(base);
            await signIn(member);
            await page.getByRole('button', { name: /^Account: / }).click();
            await page.getByRole('menuitem', { name: 'Release notes' }).click();
            await waitForPath('/releases');
            // The page's own cards: What's new's (Home, the header) share the slot.
            const cards = page.locator('[data-slot="releases-page"] [data-slot="release-card"]');
            await cards.first().waitFor({ timeout: 15_000 });
            // A page at a time: the next loads as the end scrolls near.
            const firstPage = await cards.count();
            const until = Date.now() + 30_000;
            while ((await cards.count()) < tags.length) {
                if (Date.now() > until) {
                    throw new Error(`The page stopped at ${await cards.count()} of ${tags.length} releases`);
                }
                // To the page's end, as a reader scrolls: the list ends it.
                await page
                    .locator('[data-slot="releases-page"]')
                    .evaluate((main) => main.scrollIntoView({ block: 'end' }));
                await page.waitForTimeout(250);
            }
            if (await page.locator('[data-slot="releases-end"]').count()) {
                throw new Error('The page still asks for more after the oldest release');
            }
            const shown = await cards.evaluateAll((items) => items.map((item) => item.dataset.release));
            if (shown.join() !== tags.join()) {
                throw new Error(`The page lists ${shown.join(', ')}, the API ${tags.join(', ')}`);
            }
            step(
                `the page lists all ${shown.length} releases, newest first (${firstPage} at first, more as it scrolls)`,
            );
            await page
                .locator('[data-slot="releases-page"]')
                .evaluate((main) => main.scrollIntoView({ block: 'start' }));
            const newest = cards.first();
            await page.getByText(`You’re on v${listed.current}`).waitFor({ timeout: 5_000 });
            if (listed.releases[0].version === listed.current) {
                await newest.getByText('Current', { exact: true }).waitFor();
            }
            const notes = newest.locator('[data-slot="release-notes"]');
            await notes.locator('h3').first().waitFor({ timeout: 10_000 });
            // Upstream keys link to Socio's own board in a new tab (CB-381):
            // never a local /issues/CB-n, whose number is another issue
            // here. Only the links are read; nothing follows them.
            const upstreamIssue = `${UPSTREAM_BOARD_URL}/issues/CB-`;
            if (await newest.locator('a[href^="/issues/CB-"]').count()) {
                throw new Error('The newest release links an issue key to this board');
            }
            const issueLinks = await newest.locator(`a[href^="${upstreamIssue}"]`).count();
            const sameTab = await newest.locator(`a[href^="${upstreamIssue}"]:not([target="_blank"])`).count();
            if (sameTab) {
                throw new Error(`${sameTab} upstream issue links of the newest release open in the same tab`);
            }
            // Not every release names an issue (v0.36.0 names none): fail only
            // when the notes name one and the page didn't link it.
            const namesIssue = /\bCB-\d+\b/.test((await notes.textContent()) ?? '');
            if (namesIssue && !issueLinks) {
                throw new Error('The newest release names an issue but links none');
            }
            step(`the newest release's notes are open, with ${issueLinks} issue links`);
            const shots = args.shots;
            const shot = async (name) => {
                if (!shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(shots, { recursive: true });
                for (const theme of ['light', 'dark']) {
                    await page.evaluate((value) => {
                        document.documentElement.classList.toggle('dark', value === 'dark');
                    }, theme);
                    // Past the buttons' and badges' color transitions.
                    await page.waitForTimeout(400);
                    await page.screenshot({ path: `${shots}/${name}-${theme}.png` });
                    step(`screenshot ${name}-${theme}.png`);
                }
                await page.evaluate(() =>
                    document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark'),
                );
            };
            await page.setViewportSize({ width: 1440, height: 900 });
            await shot('releases-1440');
            // Another release's notes open on demand.
            const second = cards.nth(1);
            await second.getByRole('button', { name: 'Full notes' }).click();
            await second.locator('[data-slot="release-notes"] h3').first().waitFor({ timeout: 10_000 });
            step(`${tags[1]}'s full notes open`);
            // A release's own address opens it.
            const oldest = tags.at(-1);
            await goto(`${base}/releases/${oldest}`);
            const target = page.locator(`[data-release="${oldest}"]`);
            await target.locator('[data-slot="release-notes"] h3').first().waitFor({ timeout: 10_000 });
            await page.waitForTimeout(300);
            const inView = await target.evaluate((card) => {
                const box = card.getBoundingClientRect();
                return box.top < innerHeight && box.bottom > 0;
            });
            if (!inView) {
                throw new Error(`/releases/${oldest} isn't scrolled to it`);
            }
            step(`/releases/${oldest} opens at it`);
            await shot('release-1440');
            await page.setViewportSize({ width: 390, height: 844 });
            await goto(`${base}/releases`);
            await cards.first().waitFor({ timeout: 15_000 });
            await shot('releases-390');
            await goto(`${base}/releases/v0.0.0`);
            await page.getByText('There is no release v0.0.0.').waitFor({ timeout: 10_000 });
            step('an unknown release says so');
            await page.setViewportSize({ width: 1280, height: 860 });
            await goto(`${base}/settings/account`);
            const version = page.locator('[data-slot="settings-version"]');
            await version.getByText(`Socio v${listed.current}`).waitFor({ timeout: 10_000 });
            await shot('settings-version');
            await version.getByRole('link', { name: 'Release notes' }).click();
            await waitForPath('/releases');
            step('Settings shows the version and links to the release notes');
        },
        async notifications() {
            await context.grantPermissions(['notifications'], { origin: appOrigin });
            const api = await apiSignIn(base, admin);
            const before = await api('/notifications/channels');
            notificationsRestore = {
                api,
                notifications: Object.fromEntries(
                    before.channels.map((item) => [item.id, { enabled: item.enabled, content: item.content }]),
                ),
            };
            await goto(base);
            await signIn(admin);
            // The push-only worker: registered and active, with no fetch handler.
            await page.waitForFunction(
                async () =>
                    (await navigator.serviceWorker.getRegistration('/'))?.active?.scriptURL ===
                    `${location.origin}/sw.js`,
                undefined,
                { timeout: 15_000 },
            );
            step('the service worker /sw.js is registered and active');
            // Headless Chromium says `denied` for a granted permission (the
            // Permissions API says granted): the page is told what a browser
            // would say, so the steps below reach "Turn on for this browser".
            const quirk = await page.evaluate(
                async () =>
                    Notification.permission === 'denied' &&
                    (await navigator.permissions.query({ name: 'notifications' })).state === 'granted',
            );
            if (quirk) {
                await page.addInitScript(() => {
                    Object.defineProperty(Notification, 'permission', {
                        get: () => 'granted',
                    });
                    Notification.requestPermission = async () => 'granted';
                });
                await reload();
                step('headless Chromium reports the granted permission as denied: the page sees granted');
            }
            await openSettings('Notifications');
            await waitForPath('/settings/notifications');
            const card = (id) => page.locator(`[data-slot="notification-channel"][data-channel="${id}"]`);
            await card('push').waitFor({ timeout: 15_000 });
            const shown = await page
                .locator('[data-slot="notification-channel"]')
                .evaluateAll((cards) => cards.map((item) => item.dataset.channel));
            const listed = before.channels.map((item) => item.id);
            if (shown.join() !== listed.join()) {
                throw new Error(`The page shows ${shown.join(', ')}, the server lists ${listed.join(', ')}`);
            }
            step(`the channels render: ${shown.join(', ')}`);
            // The shell's poll says whether this tab is in use (presence.ts):
            // after a click, the page's path.
            await card('push').locator('h3').click();
            const poll = await page.waitForRequest(
                (request) =>
                    new URL(request.url()).pathname === '/api/state' &&
                    (request.headers()['x-cb-presence'] ?? '').endsWith(' /settings/notifications'),
                { timeout: 10_000 },
            );
            if (!/^[A-Za-z0-9_-]{8,64} /.test(poll.headers()['x-cb-presence'])) {
                throw new Error(`Presence header: ${poll.headers()['x-cb-presence']}`);
            }
            step('the /api/state poll reports the tab in use on its path');
            const shot = async (name) => {
                if (!args.shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(args.shots, { recursive: true });
                // The shell scrolls inside its inset, not the page: a tall window
                // shows the whole section.
                await page.setViewportSize({ width: 1280, height: 1200 });
                for (const theme of ['light', 'dark']) {
                    await page.evaluate((value) => {
                        document.documentElement.classList.toggle('dark', value === 'dark');
                    }, theme);
                    await page.screenshot({ path: `${args.shots}/${name}-${theme}.png` });
                }
                await page.setViewportSize({ width: 1280, height: 860 });
                await page.evaluate(() =>
                    document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark'),
                );
                step(`screenshots ${name}-light.png, ${name}-dark.png`);
            };
            await shot('notifications');
            // Private and back, each saved.
            const content = async () =>
                (await api('/notifications/channels')).channels.find((item) => item.id === 'push').content;
            const choose = async (value) => {
                await card('push').locator(`input[value="${value}"]`).check();
                const until = Date.now() + 10_000;
                while ((await content()) !== value) {
                    if (Date.now() > until) {
                        throw new Error(`Push content stayed ${await content()}`);
                    }
                    await page.waitForTimeout(200);
                }
            };
            const start = await content();
            await choose(start === 'private' ? 'message' : 'private');
            await reload();
            await card('push').waitFor({ timeout: 15_000 });
            const checked = await card('push').locator('input[type="radio"]:checked').getAttribute('value');
            if (checked !== (start === 'private' ? 'message' : 'private')) {
                throw new Error(`After a reload, push shows ${checked}`);
            }
            await choose(start);
            step(
                `push content to ${start === 'private' ? 'message' : 'private'} and back to ${start}, saved (and kept over a reload)`,
            );
            await page.getByRole('button', { name: 'Send a test notification' }).click();
            const result = page.locator('[data-slot="test-result"]');
            await result.waitFor({ timeout: 20_000 });
            const said = await result.innerText();
            if (!/^(Sent to |No channel is on)/.test(said)) {
                throw new Error(`The test said: ${said}`);
            }
            step(`test notification: ${said}`);
            // This browser: on, or a clean message why not. A refused
            // subscription (400) logs a failed request, and Chromium logs that
            // its incognito contexts (Playwright's) have no push: expected here.
            const turnOn = card('push').getByRole('button', {
                name: 'Turn on for this browser',
            });
            const unavailable = card('push').locator('[data-slot="push-unavailable"]');
            if (await unavailable.count()) {
                step(`push here: ${await unavailable.innerText()}`);
            } else if (await turnOn.count()) {
                tolerated = /status of 400|not support the Push API in incognito/;
                await turnOn.click();
                const outcome = card('push').locator('[data-slot="push-here"], [data-slot="push-error"]');
                await outcome.first().waitFor({ timeout: 30_000 });
                tolerated = undefined;
                const text = await outcome.first().innerText();
                if ((await outcome.first().getAttribute('data-slot')) === 'push-here') {
                    const devices = (await api('/notifications/channels')).channels.find(
                        (item) => item.id === 'push',
                    ).targets;
                    const ids = new Set(
                        before.channels.find((item) => item.id === 'push')?.targets.map((item) => item.id),
                    );
                    pushDeviceAdded = devices.find((item) => !ids.has(item.id));
                    step(`push turned on in this browser: ${text}`);
                    if (pushDeviceAdded) {
                        await card('push')
                            .getByRole('button', { name: `Remove ${pushDeviceAdded.label}` })
                            .click();
                        await turnOn.waitFor({ timeout: 10_000 });
                        pushDeviceAdded = undefined;
                        step('and removed again');
                    }
                } else {
                    if (!text.trim() || /undefined|\[object/.test(text)) {
                        throw new Error(`Turning push on failed without a message: ${text}`);
                    }
                    step(`push could not be turned on here, cleanly: ${text}`);
                    await shot('notifications-push-error');
                }
            } else {
                step('push is already on in this browser');
            }
            notificationsRestore = undefined;
        },
        async operator() {
            const operator = await operatorUser(base, args);
            if (!operator) {
                step(
                    'SKIPPED: no admin to sign in as. Mock auth: add a user with role "admin" to MOCK_USERS (or pass --operator-user); Better Auth: pass --admin-email (or --operator-email) with --password-file.',
                );
                return;
            }
            users.operator = operator;
            await goto(base);
            await signIn(operator);
            const sidebar = page.locator('[data-slot="sidebar"]');
            await sidebar.getByRole('link', { name: 'Platform', exact: true }).click();
            await waitForPath('/settings/operator');
            const rows = page.locator('[data-slot="backend-row"]');
            await rows.first().waitFor({ timeout: 15_000 });
            const row = rows.filter({ hasText: 'Default' }).first();
            if (!(await row.count())) {
                throw new Error('No default backend on the Platform page');
            }
            const name = await row.getAttribute('data-backend');
            step(`the admin sees the backends; the default is "${name}"`);
            await row.getByRole('button', { name: `Test ${name}` }).click();
            const result = row.locator('[data-slot="backend-test"]');
            await page.waitForFunction(
                (backend) =>
                    [...document.querySelectorAll('[data-slot="backend-row"]')]
                        .find((element) => element.dataset.backend === backend)
                        ?.querySelector('[data-slot="backend-test"]')
                        ?.textContent?.match(/Test (passed|failed)/) && !document.body.innerText.includes('Testing…'),
                name,
                { timeout: 20_000 },
            );
            const outcome = (await result.innerText()).trim();
            if (!outcome.startsWith('Test passed')) {
                throw new Error(`The backend test did not pass: ${outcome}`);
            }
            step(`Test: ${outcome.split('(')[0].trim()}`);
            const kinds = page.locator('[data-slot="byo-kind"]');
            if (await kinds.count()) {
                const toggle = kinds.first().getByRole('switch');
                const label = await toggle.getAttribute('aria-label');
                const was = (await toggle.getAttribute('data-state')) === 'checked';
                const api = await apiSignIn(base, operator);
                byoRestore = {
                    api,
                    allowed: (await api('/inference')).byoKinds.filter((kind) => kind.allowed).map((kind) => kind.id),
                };
                for (const want of [!was, was]) {
                    await toggle.click();
                    await page.waitForFunction(
                        ([aria, state]) =>
                            document.querySelector(`[aria-label="${aria}"]`)?.getAttribute('data-state') === state,
                        [label, want ? 'checked' : 'unchecked'],
                        { timeout: 10_000 },
                    );
                }
                byoRestore = undefined;
                step(`switched "${label}" ${was ? 'off and on' : 'on and off'}`);
            } else {
                step('no bring-your-own kinds on this server; nothing to toggle');
            }
            for (const user of [users.admin, users.member]) {
                if (user.role !== 'member') {
                    step(`${user.name} is an admin too; not checked as one without`);
                    continue;
                }
                await switchUser();
                await signIn(user);
                const items = await sidebar.getByRole('link', { name: 'Platform', exact: true }).count();
                if (items) {
                    throw new Error(`${user.name} sees the Platform item`);
                }
                await goto(`${base}/settings/operator`);
                await waitForPath('/', 15_000);
                // From the API client: a 403 in the page would log a console error.
                const api = await apiSignIn(base, user);
                const status = await api('/inference').then(
                    () => 200,
                    (error) => Number(String(error.message).match(/: (\d{3}) /)?.[1]),
                );
                if (status !== 403) {
                    throw new Error(`/api/inference answers ${status} to ${user.name}`);
                }
                step(`${user.name} has no Platform page (sent home, API 403)`);
            }
        },
        async byo() {
            const kind = 'byo-chatgpt';
            const operator = await operatorUser(base, args);
            if (!operator) {
                step('SKIPPED: no admin to sign in as (see the operator scenario).');
                return;
            }
            users.operator = operator;
            const api = await apiSignIn(base, operator);
            const before = (await api('/inference')).byoKinds;
            if (!before.some((entry) => entry.id === kind)) {
                throw new Error('The server has no ChatGPT kind');
            }
            await goto(base);
            await signIn(operator);
            await page.locator('[data-slot="sidebar"]').getByRole('link', { name: 'Platform', exact: true }).click();
            await waitForPath('/settings/operator');
            const row = page.locator(`[data-slot="byo-kind"][data-kind="${kind}"]`);
            await row.waitFor({ timeout: 15_000 });
            const model = await row.getByLabel('ChatGPT model').inputValue();
            step(`Platform lists ChatGPT; its model is ${model}`);
            const toggle = row.getByRole('switch', { name: 'Allow ChatGPT' });
            if ((await toggle.getAttribute('data-state')) !== 'checked') {
                byoRestore = {
                    api,
                    allowed: before.filter((entry) => entry.allowed).map((entry) => entry.id),
                };
                await toggle.click();
                await page.waitForFunction(
                    () =>
                        document.querySelector('[aria-label="Allow ChatGPT"]')?.getAttribute('data-state') ===
                        'checked',
                    null,
                    { timeout: 10_000 },
                );
                step('the admin allowed ChatGPT');
            } else {
                step('ChatGPT was already allowed');
            }
            const member = users.member;
            await switchUser();
            await signIn(member);
            const openAccount = async () => {
                await openSettings('Inference');
                const item = page.locator('[data-slot="inference-section"]').locator(`[data-kind="${kind}"]`);
                await item.waitFor({ timeout: 15_000 });
                return item;
            };
            let item = await openAccount();
            byoConnected = await apiSignIn(base, member);
            await item.getByRole('button', { name: 'Connect' }).click();
            const code = item.locator('code');
            await code.waitFor({ timeout: 15_000 });
            const link = await item.getByRole('link', { name: 'Open the sign-in page' }).getAttribute('href');
            step(`the device code ${await code.innerText()} shows, linking ${link}`);
            await item.getByText('Connected', { exact: true }).waitFor({ timeout: 30_000 });
            const detail = (await item.innerText()).replace(/\s+/g, ' ');
            if (!/Plan: \w+/.test(detail)) {
                throw new Error(`No plan after connecting: ${detail}`);
            }
            await page
                .locator('[data-slot="inference-section"]')
                .getByText(/Your chats run on ChatGPT/)
                .waitFor({ timeout: 10_000 });
            step(`connected: ${detail}`);
            await page.keyboard.press('Escape');
            await goto(base);
            await openNewChat();
            await page.getByLabel('Start a conversation').fill('Say hello from my ChatGPT plan.');
            await page.getByLabel('Start conversation').click();
            await page.getByLabel('Message your socio').waitFor({ timeout: 30_000 });
            await waitForText(/Hello from your ChatGPT plan/);
            step('the socio answered on the ChatGPT plan');
            // The fake streams a reasoning summary first: folded above the answer.
            const thought = page.locator('[data-slot="turn-trace"]');
            await thought.getByText(/^Thought/).click({ timeout: 15_000 });
            await thought.getByText('Greeting the user from their plan.').waitFor({ timeout: 5_000 });
            step('its reasoning summary shows under “Thought for …”');
            item = await openAccount();
            await item.getByRole('button', { name: 'Disconnect' }).click();
            await item.getByText('Not connected', { exact: true }).waitFor({ timeout: 15_000 });
            byoConnected = undefined;
            await page.keyboard.press('Escape');
            step('disconnected');
        },
        async issues() {
            const stamp = Date.now().toString(36);
            const title = `Smoke issue ${stamp}`;
            const column = (status) => page.locator(`[data-slot="issue-column"][data-status="${status}"]`);
            const detail = () => page.locator('[data-slot="issue-detail"]');
            const choose = async (label, option) => {
                await detail().getByRole('combobox', { name: label, exact: true }).click();
                await page.getByRole('option', { name: option, exact: true }).click();
            };
            const patched = () =>
                page.waitForResponse(
                    (response) =>
                        response.request().method() === 'PATCH' &&
                        /\/api\/issues\/\d+$/.test(new URL(response.url()).pathname),
                    { timeout: 15_000 },
                );

            // bob files an issue with a screenshot from another module's header.
            await goto(base);
            await signIn(member);
            await navItem('Memories').click();
            await waitForText(/What your socios know about you/, 15_000);
            await header().getByRole('button', { name: 'Report issue' }).click();
            const form = page.locator('[data-slot="report-issue-form"]');
            await form.waitFor({ timeout: 5_000 });
            await form.getByRole('textbox', { name: 'Title' }).fill(title);
            await form
                .getByRole('textbox', { name: 'Description' })
                .fill('Filed by the UI smoke test. **Safe to delete.**');
            await form.locator('input[type="file"]').setInputFiles({
                name: 'smoke.png',
                mimeType: 'image/png',
                buffer: Buffer.from(
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
                    'base64',
                ),
            });
            await form.getByRole('button', { name: 'Remove smoke.png' }).waitFor();
            const filed = page.waitForResponse(
                (response) =>
                    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/issues',
            );
            const uploaded = page.waitForResponse((response) =>
                /\/api\/issues\/\d+\/attachments$/.test(new URL(response.url()).pathname),
            );
            await form.getByRole('button', { name: 'File issue' }).click();
            const response = await filed;
            if (response.status() !== 201) {
                throw new Error(`Filing answered ${response.status()}`);
            }
            const { issue } = await response.json();
            filedIssues.push(issue.number);
            const key = `CB-${issue.number}`;
            if ((await uploaded).status() !== 201) {
                throw new Error('The attachment was refused');
            }
            await page.getByText(`Filed ${key}`).waitFor({ timeout: 10_000 });
            await form.waitFor({ state: 'detached', timeout: 5_000 });
            step(`bob filed ${key} with an attachment`);

            // alice finds it in Triage and drags it to Open.
            await switchUser();
            await signIn(admin);
            await goto(`${base}/issues`);
            const card = page.locator(`[data-issue="${key}"]`);
            await column('triage').locator(`[data-issue="${key}"]`).waitFor({
                timeout: 15_000,
            });
            if ((await card.getAttribute('draggable')) !== 'true') {
                throw new Error('The admin cannot drag the card');
            }
            const moved = patched();
            await card.dragTo(column('open'));
            if ((await moved).status() !== 200) {
                throw new Error('Moving the card failed');
            }
            await column('open').locator(`[data-issue="${key}"]`).waitFor({
                timeout: 5_000,
            });
            step(`alice dragged ${key} from Triage to Open`);

            // … opens it, sets the priority and comments.
            await card.getByRole('link', { name: title }).click();
            await waitForPath(`/issues/${key}`);
            await detail().getByRole('heading', { name: title }).waitFor({
                timeout: 10_000,
            });
            await detail().locator('[data-slot="attachment"] img').waitFor({ timeout: 10_000 });
            const prioritised = patched();
            await choose('Priority', 'High');
            if ((await prioritised).status() !== 200) {
                throw new Error('Setting the priority failed');
            }
            const comment = `Triaged by the smoke test (${stamp}).`;
            await detail().getByRole('textbox', { name: 'Add a comment' }).fill(comment);
            await detail().getByRole('button', { name: 'Comment', exact: true }).click();
            await detail().locator('[data-slot="issue-comment"]').getByText(comment).waitFor({ timeout: 10_000 });
            await page.keyboard.press('Escape');
            await waitForPath('/issues');
            await column('open').locator(`[data-issue="${key}"]`).getByText('High').waitFor({ timeout: 5_000 });
            step(`alice set ${key} to High and commented; back closes it`);

            // The list view is remembered over a reload.
            await page.getByRole('button', { name: 'List view' }).click();
            await page.locator(`[data-slot="issue-row"][data-issue="${key}"]`).waitFor();
            await reload();
            await page.locator(`[data-slot="issue-row"][data-issue="${key}"]`).waitFor({ timeout: 15_000 });
            await page.getByRole('button', { name: 'Board view' }).click();
            await card.waitFor();
            step('the list view survives a reload');

            // bob sees the change, on a read-only board.
            await switchUser();
            await signIn(member);
            await goto(`${base}/issues`);
            await column('open').locator(`[data-issue="${key}"]`).getByText('High').waitFor({ timeout: 15_000 });
            if ((await card.getAttribute('draggable')) !== 'false') {
                throw new Error('The member can drag cards');
            }
            if (await page.getByRole('button', { name: `Move ${key}` }).count()) {
                throw new Error('The member has a Move menu');
            }
            if (await page.getByRole('button', { name: 'Select' }).count()) {
                throw new Error('The member has Select mode');
            }
            await goto(`${base}/issues/${key}`);
            await detail().getByText(comment).waitFor({ timeout: 10_000 });
            if (await detail().getByRole('combobox', { name: 'Status' }).count()) {
                throw new Error('The member can change the status');
            }
            step(`bob sees ${key} in Open, High, with alice's comment`);
        },
        async phases() {
            await goto(base);
            await signIn(admin);
            await openNewChat();
            await page.getByLabel('Start a conversation').fill('Smoke phases, please: take your time.');
            await page.getByLabel('Start conversation').click();
            // The status line, sampled until the answer lands.
            const seen = [];
            const line = page.locator('[data-slot="run-phase"]');
            const chatHeader = page.locator('[data-slot="chat-header"]').first();
            let foldedWhileStreaming = true;
            let sawStreaming = false;
            const until = Date.now() + 45_000;
            while (Date.now() < until) {
                const text = (await line.count()) ? (await line.innerText().catch(() => '')).trim() : '';
                const kind = text.replace(/ · \d+ s$/, '');
                if (kind && seen.at(-1) !== kind) {
                    seen.push(kind);
                }
                if (/Thinking…/.test(await chatHeader.innerText().catch(() => ''))) {
                    throw new Error('The header says Thinking… while the socio works');
                }
                const streaming = page.locator('[data-slot="turn-trace"][data-streaming]');
                if (await streaming.count()) {
                    sawStreaming = true;
                    if (await streaming.evaluate((element) => element.open)) {
                        foldedWhileStreaming = false;
                    }
                    const label = await streaming.locator('summary').innerText();
                    if (label.trim() !== 'Thinking') {
                        throw new Error(`The streaming reasoning reads "${label}"`);
                    }
                }
                if (await page.getByText('Phases done.').count()) {
                    break;
                }
                await page.waitForTimeout(150);
            }
            step(`status line: ${seen.join(' → ')}`);
            if (!seen.some((text) => /^Waiting for .*fake-model/.test(text))) {
                throw new Error('The status line never named the model');
            }
            if (!seen.some((text) => text.endsWith(' is thinking'))) {
                throw new Error('The status line never showed the reasoning');
            }
            if (!sawStreaming) {
                throw new Error('The reasoning was never seen while it streamed');
            }
            if (!foldedWhileStreaming) {
                throw new Error('The reasoning opened while it streamed');
            }
            await waitForText(/Phases done\./);
            if (await line.count()) {
                throw new Error('The status line stayed after the turn');
            }
            step('the status line followed the slow turn and went away');
            // The reasoning: "Thought for Ns" once the answer came; it opens on a
            // click, and keeps its time after a reload (CB-72).
            const reasoning = async (label) => {
                const block = page.locator('[data-slot="turn-trace"]');
                await block.waitFor({ timeout: 15_000 });
                if (await block.evaluate((element) => element.open)) {
                    throw new Error('The reasoning did not fold after the answer');
                }
                await block.getByText(label).click();
                await block.getByText(/Weighing it… the answer is short\./).waitFor({ timeout: 5_000 });
            };
            await reasoning(/^Thought for \d+s$/);
            const thought = Number(
                /(\d+)s$/.exec(await page.locator('[data-slot="turn-trace"] summary').innerText())?.[1],
            );
            // The fake reasons for 6 s; a loaded host stretches it, never halves it.
            if (!(thought >= 4 && thought <= 20)) {
                throw new Error(`The reasoning took "${thought}s", not about 6 s`);
            }
            step(`the reasoning folded under “Thought for ${thought}s”, and opens`);
            await reload();
            await waitForText(/Phases done\./);
            await reasoning(new RegExp(`^Thought for ${thought}s$`));
            step('the reasoning keeps its time after a reload');
        },
        async media() {
            const shots = args.shots;
            const shot = async (name) => {
                if (!shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(shots, { recursive: true });
                await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
                step(`screenshot ${name}.png`);
            };
            // A 1×1 PNG, pasted as a screenshot would be.
            const png =
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
            await goto(base);
            await signIn(admin);
            await openNewChat();
            const composer = page.locator('form[data-slot="new-chat-composer"]');
            const tray = composer.locator('[data-slot="tray-item"]');
            await page.getByLabel('Start a conversation').evaluate((input, data) => {
                const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
                const clipboard = new DataTransfer();
                clipboard.items.add(new File([bytes], 'smoke-dot.png', { type: 'image/png' }));
                input.dispatchEvent(
                    new ClipboardEvent('paste', {
                        clipboardData: clipboard,
                        bubbles: true,
                        cancelable: true,
                    }),
                );
            }, png);
            const drop = () =>
                composer.evaluate((form) => {
                    const dropped = new DataTransfer();
                    dropped.items.add(
                        new File(['# Smoke notes\n\nTwo lines.\n'], 'smoke-notes.md', {
                            type: 'text/markdown',
                        }),
                    );
                    for (const type of ['dragover', 'drop']) {
                        form.dispatchEvent(
                            new DragEvent(type, {
                                dataTransfer: dropped,
                                bubbles: true,
                                cancelable: true,
                            }),
                        );
                    }
                });
            await drop();
            const ready = (count) =>
                page.waitForFunction(
                    (want) => document.querySelectorAll('[data-slot="tray-item"][data-status="ready"]').length === want,
                    count,
                    { timeout: 20_000 },
                );
            await ready(2);
            // The thumbnail is the uploaded original, loaded from the app.
            await page.waitForFunction(
                () => document.querySelector('img[data-slot="tray-thumb"]')?.naturalWidth === 1,
                undefined,
                { timeout: 10_000 },
            );
            step('pasted a PNG and dropped a .md: both uploaded, with a thumbnail');
            await composer.getByRole('button', { name: 'Remove smoke-notes.md' }).click();
            await ready(1);
            await drop();
            await ready(2);
            if ((await tray.count()) !== 2) {
                throw new Error(`The tray has ${await tray.count()} items, not 2`);
            }
            step('removed the .md before sending and added it back');
            await shot('media-composer');
            await page.getByLabel('Start a conversation').fill('smoke media: what is in these?');
            await page.getByLabel('Start conversation').click();
            await waitForText(/Smoke media: I see \d image\(s\) and 1 file note/);
            const seen = await page
                .getByText(/Smoke media: I see/)
                .first()
                .innerText();
            if (!seen.includes('I see 1 image(s)')) {
                throw new Error(
                    `The model was not shown the image (${seen}); start the server with MODEL_ACCEPTS_IMAGES=true`,
                );
            }
            step('the model got the image and a note for the file');
            const bubble = page.locator('[data-chat-body="user"]').last();
            const checkBubble = async () => {
                await bubble.locator('a[data-attachment="file"]').getByText('smoke-notes.md').waitFor({
                    timeout: 15_000,
                });
                await page.waitForFunction(
                    () =>
                        [...document.querySelectorAll('[data-attachment="image"] img')].some(
                            (image) => image.naturalWidth === 1,
                        ),
                    undefined,
                    { timeout: 15_000 },
                );
            };
            await checkBubble();
            const ids = [
                ...(await bubble
                    .locator('[data-attachment="image"] img')
                    .evaluateAll((images) => images.map((image) => image.getAttribute('src')))),
                ...(await bubble
                    .locator('a[data-attachment="file"]')
                    .evaluateAll((links) => links.map((link) => link.getAttribute('href')))),
            ].map((url) => url.split('/')[4]);
            const api = await apiSignIn(base, admin);
            for (const id of ids) {
                createdFiles.push([admin, (await api(`/media/attachments/${id}`)).path]);
            }
            await shot('media-bubble');
            if (shots) {
                await page.locator('[data-attachment="image"]').first().click();
                await page.getByRole('dialog').getByText('Download').waitFor();
                // Past the dialog's open animation.
                await page.waitForTimeout(500);
                await shot('media-image-dialog');
                await page.keyboard.press('Escape');
            }
            await reload();
            await checkBubble();
            step('the bubble shows the thumbnail and the file chip, after a reload too');
            if (shots) {
                await page.evaluate(() => localStorage.setItem('theme', 'dark'));
                await reload();
                await checkBubble();
                await shot('media-bubble-dark');
                await page.evaluate(() => localStorage.removeItem('theme'));
                await reload();
            }
            // From the API clients: a 404 in the page would log a console error.
            const owner = await fetch(`${base}/api/media/attachments/${ids[0]}/content`, {
                headers: api.headers,
            });
            if (owner.status !== 200 || owner.headers.get('content-type') !== 'image/png') {
                throw new Error(`alice reads her image: ${owner.status}`);
            }
            const other = await apiSignIn(base, member);
            for (const id of ids) {
                const response = await fetch(`${base}/api/media/attachments/${id}/content`, {
                    headers: other.headers,
                });
                if (response.status !== 404) {
                    throw new Error(`bob reads alice's attachment: ${response.status}`);
                }
            }
            step(`${member.name} gets 404 for ${admin.name}'s attachments`);

            // The Media page: the attachments under attachments/<day>/, with a
            // link to their conversation.
            const day = new Date().toISOString().slice(0, 10);
            await goto(`${base}/media?folder=${encodeURIComponent(`attachments/${day}/`)}&view=list`);
            const list = page.locator('[data-slot="media-list"]');
            for (const name of ['smoke-dot.png', 'smoke-notes.md']) {
                await list
                    .getByRole('button', { name: `Open ${name}` })
                    .first()
                    .waitFor({ timeout: 15_000 });
            }
            const from = await list.locator('[data-slot="media-from"]').first().getAttribute('href');
            if (!from?.startsWith('/chats/')) {
                throw new Error(`No link to the conversation (${from})`);
            }
            step('Media lists the attachments under their day, linked to the chat');
            await goto(`${base}/media`);
            await page.locator('[data-slot="media-folders"]').waitFor();
            await shot('media-page');

            // A new folder, an upload into it, a move, a download and a delete.
            const folder = `smoke-media-${Date.now().toString(36)}`;
            createdFolders.push([admin, `${folder}/`]);
            await page.getByRole('button', { name: 'New folder' }).click();
            const naming = page.locator('[data-slot="media-move-dialog"]');
            await naming.getByLabel('Name').fill(folder);
            await naming.getByRole('button', { name: 'Create' }).click();
            await page.locator('[data-slot="media-crumbs"]').getByText(folder).waitFor();
            await page.getByLabel('Upload files').setInputFiles({
                name: 'smoke-upload.txt',
                mimeType: 'text/plain',
                buffer: Buffer.from('Uploaded by the smoke test.\n'),
            });
            const card = page.getByRole('button', { name: 'Open smoke-upload.txt' });
            await card.waitFor({ timeout: 15_000 });
            step(`uploaded a file into a new folder ${folder}/`);
            await card.click();
            const preview = page.locator('[data-slot="media-preview"]');
            await preview.getByText('Uploaded by the smoke test.').waitFor();
            const [download] = await Promise.all([
                page.waitForEvent('download'),
                preview.getByRole('link', { name: 'Download' }).click(),
            ]);
            if (download.suggestedFilename() !== 'smoke-upload.txt') {
                throw new Error(`Downloaded ${download.suggestedFilename()}`);
            }
            step('previewed the text and downloaded it');
            await preview.getByRole('button', { name: 'Move or rename' }).click();
            const moving = page.locator('[data-slot="media-move-dialog"]');
            await moving.getByLabel('Name').fill('smoke-moved.txt');
            await moving.getByRole('button', { name: 'Move' }).click();
            const moved = page.getByRole('button', { name: 'Open smoke-moved.txt' });
            await moved.waitFor({ timeout: 15_000 });
            step('renamed it');
            await moved.click();
            await preview.getByRole('button', { name: 'Delete' }).click();
            await page.locator('[data-slot="media-confirm-delete"]').getByRole('button', { name: 'Delete' }).click();
            await page.locator('[data-slot="media-empty"]').waitFor();
            step('deleted it');
            if (shots) {
                await page.evaluate(() => localStorage.setItem('theme', 'dark'));
                await goto(`${base}/media`);
                await page.locator('[data-slot="media-folders"]').waitFor();
                await shot('media-page-dark');
                await page.evaluate(() => localStorage.removeItem('theme'));
            }
        },
        async data() {
            const shots = args.shots;
            const shot = async (name) => {
                if (!shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(shots, { recursive: true });
                await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
                step(`screenshot ${name}.png`);
            };
            const setDark = async (dark) => {
                await page.evaluate((value) => {
                    localStorage.setItem('theme', value ? 'dark' : 'light');
                }, dark);
                await reload();
                await page.locator('[data-slot="app-header"]').waitFor();
            };
            await goto(base);
            await signIn(admin);
            await openNewChat();
            await page
                .getByLabel('Start a conversation')
                .fill('Please keep some smoke data for me: three fruit prices.');
            await page.getByLabel('Start conversation').click();
            await waitForText(/Saved 3 prices in smoke_prices/);
            step('the socio wrote to its scratch dataset');
            const card = page.locator('[data-slot="approval-card"]').first();
            await card.waitFor({ timeout: 30_000 });
            await card.getByText(/Smoke watchlist/).waitFor();
            await shot('chat-approval-card');
            await card.getByRole('button', { name: 'Approve' }).click();
            await card.getByText(/Created dataset “Smoke watchlist”/).waitFor({
                timeout: 15_000,
            });
            step('approved the new dataset in the chat card');
            const api = await apiSignIn(base, admin);
            const before = await api('/data');
            for (const dataset of before.datasets) {
                if (dataset.access === 'owner') {
                    createdDatasets.push([admin, dataset.id]);
                }
            }
            await navItem('Data').click();
            await waitForPath('/data');
            const row = page.locator('[data-dataset$=" scratch"]').first();
            await row.waitFor({ timeout: 15_000 });
            await page.locator('[data-dataset="Smoke watchlist"]').waitFor();
            await shot('data-list');
            if (shots) {
                await page.getByRole('tab', { name: 'Socio access' }).click();
                await page.locator('[data-dot]').first().waitFor();
                await shot('data-dot-access');
                await page.getByRole('tab', { name: 'Usage' }).click();
                await page.getByText('Your usage').waitFor();
                await shot('data-usage');
                await page.getByRole('tab', { name: 'Datasets' }).click();
            }
            await row.getByRole('link').click();
            await page.locator('[data-slot="dataset-page"]').waitFor();
            await page.getByRole('tab', { name: /smoke_prices/ }).waitFor();
            await page.getByText('pear', { exact: true }).waitFor();
            if ((await page.locator('[data-slot="rows-range"]').innerText()) !== '1–3 of 3') {
                throw new Error('The table browser shows the wrong rows');
            }
            step('browsed smoke_prices (3 rows)');
            await page.getByLabel('SQL query').fill('SELECT sku FROM smoke_prices WHERE price > 1 ORDER BY sku');
            await page.getByRole('button', { name: 'Run query' }).click();
            const result = page.getByRole('table', { name: 'Query result' });
            await result.getByText('apple').waitFor();
            if ((await result.locator('tbody tr').count()) !== 2) {
                throw new Error('The query returned the wrong rows');
            }
            await page.getByLabel('SQL query').fill('DELETE FROM smoke_prices');
            tolerated = /status of 400/;
            await page.getByRole('button', { name: 'Run query' }).click();
            await page.getByText(/read-only SELECT/).waitFor();
            step('ran a read-only query; a DELETE was refused');
            await shot('dataset-light');
            const [download] = await Promise.all([
                page.waitForEvent('download'),
                page.getByRole('link', { name: 'Export CSV' }).click(),
            ]);
            const { readFileSync } = await import('node:fs');
            const csv = readFileSync(await download.path(), 'utf8');
            if (!csv.startsWith('sku,price,seen_at\r\n') || !csv.includes('plum')) {
                throw new Error(`Unexpected CSV export: ${csv.slice(0, 80)}`);
            }
            step(`exported CSV (${download.suggestedFilename()})`);
            // The refusal's console line may arrive late; stop tolerating it now.
            tolerated = undefined;
            await setDark(true);
            await page.getByText('pear', { exact: true }).waitFor();
            await shot('dataset-dark');
            await goto(`${base}/approvals`);
            await page.locator('[data-slot="approvals-page"]').waitFor();
            await page
                .getByText(/Smoke watchlist/)
                .first()
                .waitFor();
            await shot('approvals-dark');
            await setDark(false);
            await shot('approvals-light');
            await page.goBack();
            await goto(`${base}/data`);
            await page.locator('[data-dataset$=" scratch"]').first().getByRole('link').click();
            await page.locator('[data-slot="dataset-page"]').waitFor();
            await page.getByRole('button', { name: 'Delete' }).click();
            await page.getByRole('alertdialog').waitFor();
            await page.getByRole('button', { name: 'Delete dataset' }).click();
            await waitForPath('/data');
            await page.locator('[data-dataset="Smoke watchlist"]').waitFor();
            if (await page.locator('[data-dataset$=" scratch"]').count()) {
                throw new Error('The deleted dataset is still listed');
            }
            step('deleted the scratch dataset');
        },
        async auto() {
            const shot = async (name) => {
                if (!args.shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(args.shots, { recursive: true });
                await page.screenshot({
                    path: `${args.shots}/${name}.png`,
                    fullPage: true,
                });
                step(`screenshot ${name}.png`);
            };
            const policy = () => page.getByLabel('Approval policy for Create datasets');
            const banner = () => page.locator('[data-slot="auto-banner"]');
            await goto(base);
            await signIn(admin);
            const api = await apiSignIn(base, admin);
            autoRestore = { api, dotId: undefined };
            await goto(`${base}/approvals`);
            await page.locator('[data-slot="approval-policies"]').waitFor();
            autoRestore.dotId = await page.locator('[data-slot="approval-dot"]').inputValue();
            await policy().selectOption('auto');
            await banner()
                .getByText(/Auto approvals are on for/)
                .waitFor();
            step('set Create datasets to Auto; the banner shows');
            await page
                .getByLabel('Guidance for auto approvals')
                .fill('Datasets the socio needs for my lists are fine.');
            await page.getByRole('button', { name: 'Save guidance' }).click();
            await page.getByText('Guidance saved.').waitFor();
            step('saved guidance for auto approvals');
            await shot('approvals-auto-policies');
            await goto(base);
            await openNewChat();
            await page
                .getByLabel('Start a conversation')
                .fill('Please keep some smoke data for me: three fruit prices.');
            await page.getByLabel('Start conversation').click();
            await waitForText(/Saved 3 prices in smoke_prices/);
            const card = page.locator('[data-slot="approval-card"]').first();
            await card.waitFor({ timeout: 30_000 });
            await card.getByText('Approved (auto)').waitFor({ timeout: 15_000 });
            await card
                .locator('[data-slot="auto-review"]')
                .getByText(/as the smoke test’s guidance allows/)
                .waitFor();
            await card.getByText(/Created dataset “Smoke watchlist”/).waitFor();
            step('the dataset request was approved by auto review, with its reason');
            await shot('chat-auto-card');
            for (const dataset of (await api('/data')).datasets) {
                if (dataset.access === 'owner') {
                    createdDatasets.push([admin, dataset.id]);
                }
            }
            await goto(`${base}/approvals`);
            await page.getByLabel('Show decisions').selectOption('auto');
            const row = page.locator('[data-request]').filter({ hasText: 'Smoke watchlist' }).first();
            await row.getByText('Approved (auto)').waitFor({ timeout: 15_000 });
            await row.getByRole('button', { name: 'Undo' }).click();
            await row.getByText(/Undone: Deleted dataset “Smoke watchlist”/).waitFor({ timeout: 15_000 });
            if ((await api('/data')).datasets.some((d) => d.name === 'Smoke watchlist')) {
                throw new Error('Undo left the dataset in place');
            }
            step('found the auto decision under Auto reviews and undid it');
            await shot('approvals-auto-recent');
            await banner().getByRole('button', { name: 'Turn off auto' }).click();
            await banner().waitFor({ state: 'detached', timeout: 15_000 });
            if ((await policy().inputValue()) !== 'manual') {
                throw new Error('Turning auto off left the policy on auto');
            }
            step('turned auto off from the banner');
        },
        async views() {
            // Creates a page and a dataset: a throwaway database only.
            if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) {
                throw new Error('The views scenario creates pages: loopback only.');
            }
            const shots = args.shots;
            const shot = async (name) => {
                if (!shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(shots, { recursive: true });
                await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
                step(`screenshot ${name}.png`);
            };
            const setDark = async (dark) => {
                await page.evaluate((value) => {
                    localStorage.setItem('theme', value ? 'dark' : 'light');
                }, dark);
                await reload();
                await page.locator('[data-slot="app-header"]').waitFor();
            };
            const api = await apiSignIn(base, admin);
            const { spaces } = await api('/workspace');
            const space = spaces[0].id;
            const report = await api(`/spaces/${space}/pages`, 'POST', {
                title: `Smoke views ${Date.now()}`,
                content: '# Sales\n\nMonthly totals, from the socio.\n',
            });
            createdPages.push([space, report.id]);
            const reportPath = `/spaces/${space}/pages/${report.id}`;
            await goto(base);
            await signIn(admin);
            await openNewChat();
            await page
                .getByLabel('Start a conversation')
                .fill(`Please add a smoke view to page ${space}/${report.id}.`);
            await page.getByLabel('Start conversation').click();
            await waitForText(/Added the Smoke sales view/);
            step('the socio embedded a view with insert_dataset_view');
            const own = (await api('/data')).datasets.filter((dataset) => dataset.access === 'owner');
            for (const dataset of own) {
                createdDatasets.push([admin, dataset.id]);
            }
            const scratch = own.find((dataset) => dataset.kind === 'scratch');
            if (!scratch) {
                throw new Error('No scratch dataset after the view turn');
            }
            await goto(`${base}${reportPath}`);
            const views = page.locator('[data-slot="dataset-view"]');
            const first = views.first();
            await first.locator('svg[data-chart="bar"]').waitFor({ timeout: 30_000 });
            if ((await first.locator('.marks path').count()) !== 4) {
                throw new Error('The bar chart has the wrong number of bars');
            }
            await first.getByText('Smoke sales', { exact: true }).waitFor();
            await first.locator('[data-slot="view-private"]').waitFor();
            step('the page draws the bar chart, for its owner only so far');
            await first.locator('svg[data-chart="bar"]').hover();
            await first.locator('.series-chart-tooltip').waitFor();
            await shot('views-bar-light');
            await setDark(true);
            await first.locator('svg[data-chart="bar"]').waitFor();
            await shot('views-bar-dark');
            await setDark(false);
            // Edit in place: a line chart.
            await first.getByRole('button', { name: 'Edit view' }).click();
            const form = first.getByRole('form', { name: 'Edit dataset view' });
            await form.getByLabel('Display').selectOption('line');
            await shot('views-edit-light');
            await form.getByRole('button', { name: 'Save view' }).click();
            await first.locator('svg[data-chart="line"]').waitFor();
            step('edited the view in place: now a line chart');
            // A second view from the / block menu: a table.
            const last = page.locator('.document-prose p').last();
            await last.click();
            // ProseMirror takes a click's caret from the next selectionchange,
            // which can come after keys sent at once: wait until the editor's
            // selection is in the clicked paragraph (Tiptap sets dom.editor).
            await last.evaluate(
                (p) =>
                    new Promise((done) => {
                        const check = () =>
                            p.closest('.ProseMirror').editor.state.selection.$from.parent.textContent === p.textContent
                                ? done()
                                : requestAnimationFrame(check);
                        check();
                    }),
            );
            await page.keyboard.press('End');
            await page.keyboard.press('Enter');
            await page.keyboard.type('/Dataset');
            await page.locator('#document-block-menu').getByText('Dataset view').waitFor();
            await page.keyboard.press('Enter');
            const second = views.nth(1);
            const insert = second.getByRole('form', { name: 'Edit dataset view' });
            await insert.waitFor();
            await insert.getByLabel('Dataset').selectOption(scratch.id);
            await insert.getByLabel('View query').fill('SELECT month, total FROM smoke_sales ORDER BY total DESC');
            await insert.getByLabel('View title').fill('Best months');
            await insert.getByRole('button', { name: 'Run', exact: true }).click();
            await second.locator('tbody tr').nth(3).waitFor();
            await insert.getByRole('button', { name: 'Save view' }).click();
            await insert.waitFor({ state: 'detached' });
            const firstRow = await second.locator('tbody tr').first().innerText();
            if (!/2026-10\s+160/.test(firstRow)) {
                throw new Error(`The table's first row is ${firstRow}`);
            }
            const align = await second
                .locator('td.numeric')
                .first()
                .evaluate((cell) => getComputedStyle(cell).textAlign);
            if (align !== 'right') {
                throw new Error(`Numbers align ${align}`);
            }
            step('inserted a table view from the / menu');
            await page.getByText('All changes saved').waitFor({ timeout: 15_000 });
            const saved = await api(`/spaces/${space}/pages/${report.id}`);
            const fences = saved.content.match(/```dataset-view/g) ?? [];
            if (
                fences.length !== 2 ||
                !saved.content.includes('"display": "line"') ||
                !saved.content.includes('"title": "Best months"')
            ) {
                throw new Error('The page Markdown lacks the edited views');
            }
            step('both views are saved in the page Markdown');
            await shot('views-owner-light');
            // Bob: the page is shared with the team, the dataset isn't yet.
            tolerated = /status of 403/;
            await switchUser();
            await signIn(member);
            await goto(`${base}${reportPath}`);
            await views
                .first()
                .locator('[data-state="denied"]')
                .getByText(/ask its owner to share it with this Space/)
                .waitFor({ timeout: 30_000 });
            await views.nth(1).locator('[data-state="denied"]').waitFor();
            if (
                await page
                    .locator('[data-slot="dataset-view"] svg[data-chart], [data-slot="dataset-view"] table')
                    .count()
            ) {
                throw new Error('Bob sees data he has no access to');
            }
            step('bob sees the no-access placeholder on both views');
            await shot('views-denied-light');
            await api(`/data/datasets/${scratch.id}`, 'PATCH', {
                sharedSpaceId: space,
            });
            await reload();
            await views.first().locator('svg[data-chart="line"]').waitFor({
                timeout: 30_000,
            });
            await views.nth(1).locator('tbody tr').nth(3).waitFor();
            if (await page.locator('[data-slot="view-private"]').count()) {
                throw new Error('Bob was told the data is private to him');
            }
            step('shared with the Space: bob sees the chart and the table');
            tolerated = undefined;
            await setDark(true);
            await views.nth(1).locator('tbody tr').first().waitFor();
            await shot('views-shared-dark');
            await setDark(false);
        },
        async schedules() {
            const shots = args.shots;
            const shot = async (name) => {
                if (!shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(shots, { recursive: true });
                await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
                step(`screenshot ${name}.png`);
            };
            const setDark = async (dark) => {
                await page.evaluate((value) => {
                    localStorage.setItem('theme', value ? 'dark' : 'light');
                }, dark);
                await reload();
                await page.locator('[data-slot="app-header"]').waitFor();
            };
            await goto(base);
            await signIn(admin);
            const api = await apiSignIn(base, admin);
            const firstDot = (await api('/workspace')).dots[0];
            await api(`/dots/${firstDot.id}/computer/permissions`, 'PATCH', {
                enabled: true,
                browser: true,
                files: true,
                shell: true,
            });
            step('enabled the first socio’s computer (shell) for the job');
            await openNewChat();
            await page
                .getByLabel('Start a conversation')
                .fill('Please set up a smoke schedule for me: prices every morning.');
            await page.getByLabel('Start conversation').click();
            await waitForText(/approve both in the cards/);
            const cards = page.locator('[data-slot="approval-card"]');
            await cards.nth(1).waitFor({ timeout: 30_000 });
            await shot('chat-approval-cards');
            const jobCard = cards.filter({ hasText: 'Smoke prices' }).first();
            await jobCard.getByRole('button', { name: 'Approve' }).click();
            await jobCard.getByText(/Saved job “Smoke prices” version 1/).waitFor({ timeout: 15_000 });
            const scheduleCard = cards.filter({ hasText: 'Smoke morning digest' }).first();
            await scheduleCard.getByRole('button', { name: 'Approve' }).click();
            await scheduleCard.getByText(/Schedule “Smoke morning digest” created/).waitFor({ timeout: 15_000 });
            step('approved the job and the schedule in the chat cards');
            const state = await api('/schedules');
            for (const item of state.schedules) {
                if (item.threadId) {
                    created.push(Promise.resolve({ userId: admin.id, id: item.threadId }));
                }
            }
            createdJobs.push(...state.jobs.map((job) => [admin, job.id]));
            // The user's own scheduled task, from the conversation's clock button.
            await page.getByRole('button', { name: 'Schedule a task in this conversation' }).click();
            await page.getByLabel('Task to revisit').fill('Smoke weekly notes');
            await page.getByLabel('Repeat after each successful run').selectOption({
                label: 'Every week',
            });
            await page.getByRole('button', { name: 'Save', exact: true }).click();
            await page.getByRole('dialog').waitFor({ state: 'detached' });
            step('scheduled a task from the conversation (the existing dialog)');
            await navItem('Schedules').click();
            await waitForPath('/schedules');
            const row = page.locator('[data-schedule]').filter({ hasText: 'Smoke morning digest' });
            await row.waitFor({ timeout: 15_000 });
            await row.getByText('every day at 09:00 (Europe/Paris)').waitFor();
            await page
                .locator('[data-schedule]')
                .filter({ hasText: 'Smoke weekly notes' })
                .getByText(/made by you/)
                .waitFor();
            await shot('schedules-light');
            await row.getByRole('button', { name: 'Pause' }).click();
            await row.getByRole('button', { name: 'Resume' }).waitFor();
            await row.getByText('paused', { exact: true }).waitFor();
            await row.getByRole('button', { name: 'Resume' }).click();
            await row.getByText('scheduled', { exact: true }).waitFor();
            step('paused and resumed the schedule');
            await page.getByRole('tab', { name: 'Jobs' }).click();
            const job = page.locator('[data-job]').filter({ hasText: 'Smoke prices' });
            await job.waitFor();
            await job.getByRole('button', { name: 'Run now' }).click();
            await job.getByRole('button', { name: 'Details' }).click();
            const runs = page.locator('[data-slot="job-runs"]');
            await runs.locator('[data-status="succeeded"]').first().waitFor({ timeout: 40_000 });
            step('ran the job in the (stand-in) computer');
            await runs.getByRole('button', { name: 'Logs' }).first().click();
            await page.locator('[data-slot="job-logs"]').getByText('fetched 3 prices').waitFor();
            await page.locator('[data-slot="job-detail"]').getByRole('button', { name: 'Code' }).first().click();
            await page
                .locator('[data-slot="job-code"]')
                .getByText(/CB_DATA_TOKEN/)
                .waitFor();
            step('read the run’s logs and the job’s code');
            await shot('jobs-light');
            await setDark(true);
            await page.getByRole('tab', { name: 'Jobs' }).waitFor();
            await shot('schedules-dark');
            // Admins see the workspace's counts (CB-390).
            await page.getByRole('tab', { name: 'Workspace' }).click();
            await page.locator('[data-slot="schedule-counts"]').waitFor();
            await shot('schedules-workspace-dark');
            step('the admin sees the workspace’s counts');
            await setDark(false);
            // The member sees none of it.
            await switchUser();
            await signIn(member);
            await goto(`${base}/schedules`);
            await page.getByText(/No schedules yet/).waitFor({ timeout: 15_000 });
            if (await page.getByText('Smoke morning digest').count()) {
                throw new Error('The member sees the admin’s schedule');
            }
            if (await page.getByRole('tab', { name: 'Workspace' }).count()) {
                throw new Error('The member sees the workspace’s counts');
            }
            await page.getByRole('tab', { name: 'Jobs' }).click();
            await page.getByText(/No jobs yet/).waitFor();
            await shot('schedules-member');
            step('bob sees no one else’s schedules or jobs');
            for (const item of state.schedules) {
                await api(`/schedules/${item.id}/actions`, 'POST', {
                    action: 'cancel',
                });
            }
        },
        async chat({ transcript = true } = {}) {
            await goto(base);
            if ((await page.title()) !== 'Socio') {
                throw new Error(`Unexpected page title: ${await page.title()}`);
            }
            await signIn(admin);
            for (const label of ['Create socio', 'Create Space', 'Pause all socios']) {
                if (!(await page.getByLabel(label).count())) {
                    throw new Error(`Admin is missing the ${label} control`);
                }
            }
            await openNewChat();
            await page
                .getByLabel('Start a conversation')
                .fill('In one sentence, what is SQLite? Mention the word "embedded".');
            await page.getByLabel('Start conversation').click();
            await page.getByLabel('Message your socio').waitFor({ timeout: 30_000 });
            await waitForText(/embedded/);
            step('first answer rendered');
            await page.getByLabel('Message your socio').fill('Now reply with exactly the word: pelican');
            await page.getByLabel('Send message').click();
            await waitForText(/pelican[\s\S]*pelican/);
            step('follow-up answered');
            if (transcript) {
                await transcriptChecks();
            }
            await page.waitForTimeout(4000); // let the automatic title land
            await reload();
            await page.waitForSelector('[data-thread-title]', { timeout: 30_000 });
            const title = await page.locator('[data-thread-title]').first().innerText();
            step(`sidebar title: ${JSON.stringify(title)}`);
            await page.locator('[data-thread-title]').first().click();
            await waitForText(/embedded[\s\S]*pelican/, 30_000);
            step('history restored after reload');
            await chatMenu();
            await teamTopic(admin);
            await switchUser();
            await signIn(member);
            await teamTopic(member);
            await switchUser();
            await signIn(admin);
            return title;
        },
        async research() {
            await goto(base);
            await signIn(admin);
            await openNewChat();
            await page
                .getByLabel('Start a conversation')
                .fill(
                    'Use search_web to find what SQLite WAL mode is. Answer in two sentences and cite one source URL.',
                );
            await page.getByLabel('Start conversation').click();
            await waitForText(/https?:\/\/\S+/, 180_000);
            step('research answer with a cited URL');
        },
        async learning() {
            await goto(base);
            await signIn(admin);
            // Kept to undo the change below at cleanup.
            dotsBefore = (await (await apiSignIn(base, admin))('/workspace')).dots;
            // Assign the socio to a learning container with delivery on.
            await openDotSettings();
            await page.getByLabel('Learning container ID').fill('smoke-test');
            await page.getByText('Use published skills').click();
            await page.getByRole('button', { name: 'Save' }).click();
            await page.getByRole('dialog').waitFor({ state: 'detached' });
            await navItem('Learning').click();
            await page
                .getByRole('navigation', { name: 'Learning containers' })
                .getByText('smoke-test')
                .waitFor({ timeout: 15_000 });
            step('admin sees the learning container');
            // Analyze now has never worked: it is behind the flag
            // `learning-analyze-now` (Settings → Features), off by default.
            // Off, the button isn't there and its route answers 404.
            const adminApi = await apiSignIn(base, admin);
            if ((await adminApi('/workspace')).flags?.on.includes('learning-analyze-now')) {
                await page.getByRole('button', { name: 'Analyze now' }).click();
                await waitForText(/Last run: succeeded \(manual\)/, 30_000);
                step('manual analysis ran');
            } else {
                await page.getByRole('heading', { name: 'smoke-test' }).waitFor({ timeout: 15_000 });
                if (await page.getByRole('button', { name: 'Analyze now' }).count()) {
                    throw new Error('Analyze now shows while learning-analyze-now is off');
                }
                const refused = await adminApi('/learning/containers/smoke-test/analyze', 'POST', {}).then(
                    () => 'ran',
                    (error) => String(error.message ?? error),
                );
                if (!/404/.test(refused)) {
                    throw new Error(`Analyze now's route with the flag off: ${refused}`);
                }
                step('Analyze now hidden and its route 404 (learning-analyze-now off)');
            }
            await switchUser();
            await signIn(member);
            await navItem('Skills').click();
            await waitForText(/Published skills/, 15_000);
            if (await page.getByRole('button', { name: 'Analyze now' }).count()) {
                throw new Error('Member sees learning controls');
            }
            if (await page.getByRole('navigation', { name: 'Learning containers' }).count()) {
                throw new Error('Member sees learning containers');
            }
            step('member sees only published skills');
        },
        async search() {
            // Creates a page, so it only runs on loopback. It needs no model.
            if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) {
                throw new Error('The search scenario creates a page: loopback only.');
            }
            const api = await apiSignIn(base, admin);
            const { spaces } = await api('/workspace');
            const space = spaces[0].id;
            // A made-up word of letters only, new each run, in the body alone.
            const stamp = Date.now()
                .toString()
                .replace(/\d/g, (digit) => 'bcdfghjkmn'[digit]);
            const word = `quokka${stamp}`;
            const typo = `qoukka${stamp}`;
            const inside = word.slice(3, 11);
            const title = `Search smoke ${stamp}`;
            const created = await api(`/spaces/${space}/pages`, 'POST', {
                title,
                content: `# Notes\n\nThe team keeps the **${word}** ledger on this page.`,
            });
            createdPages.push([space, created.id]);
            await goto(base);
            await signIn(admin);
            const input = () => palette().getByLabel('Search Socio');
            const hit = () =>
                palette()
                    .getByRole('option', { name: new RegExp(title) })
                    .first();
            await page.keyboard.press('ControlOrMeta+k');
            await palette().waitFor({ timeout: 5_000 });
            await input().fill(word);
            await hit().waitFor({ timeout: 10_000 });
            const marked = await hit().locator('mark').allInnerTexts();
            const detail = await hit().locator('[data-slot="palette-detail"]').innerText();
            if (marked.join() !== word || !detail.startsWith('Edited today · ')) {
                throw new Error(`The text hit: marked ${JSON.stringify(marked)}, line "${detail}"`);
            }
            step(`⌘K finds the page by its text, the word marked: "${detail}"`);
            await input().fill(typo);
            const correction = palette().locator('[data-slot="palette-correction"]');
            await correction.waitFor({ timeout: 10_000 });
            const said = (await correction.innerText()).replace(/\s+/g, ' ');
            if (!said.includes(`Showing results for ${word}`) || !said.includes(`Search instead for ${typo}`)) {
                throw new Error(`The correction line: "${said}"`);
            }
            await hit().waitFor({ timeout: 5_000 });
            step(`a misspelling is corrected: "${said}"`);
            await correction.click();
            await palette().getByText('Nothing found.').waitFor({ timeout: 10_000 });
            if (await correction.count()) {
                throw new Error('The correction stayed after searching instead');
            }
            step('"Search instead" searches the misspelling: nothing found');
            await input().fill(inside);
            await hit().waitFor({ timeout: 10_000 });
            if ((await hit().locator('mark').allInnerTexts()).join() !== word) {
                throw new Error('The text inside a word was not marked');
            }
            step(`the middle of the word ("${inside}") finds it too`);
            const used = page.waitForResponse(
                (response) =>
                    response.request().method() === 'POST' &&
                    new URL(response.url()).pathname === `/api/spaces/${space}/pages/${created.id}/used`,
            );
            await hit().click();
            await waitForPath(`/spaces/${space}/pages/${created.id}`);
            if ((await used).status() !== 204) {
                throw new Error('Opening a hit did not record a use');
            }
            step('opening the hit goes to the page and records a use');
            await goto(`${base}/spaces/${space}`);
            await page.getByLabel('Search pages').fill(word);
            const card = page.locator('[data-slot="library-page-card"]').filter({ hasText: title }).first();
            await card.locator('mark').waitFor({ timeout: 10_000 });
            const fresh = await card.locator('[data-slot="library-freshness"]').innerText();
            if (fresh !== 'Edited today') {
                throw new Error(`The library card's freshness: "${fresh}"`);
            }
            step(`the Space library's search finds it too, "${fresh}"`);
            await api(`/spaces/${space}/pages/${created.id}`, 'DELETE');
            createdPages.splice(
                createdPages.findIndex(([, id]) => id === created.id),
                1,
            );
            await page.keyboard.press('ControlOrMeta+k');
            await palette().waitFor({ timeout: 5_000 });
            await input().fill(word);
            await palette().getByText('Nothing found.').waitFor({ timeout: 10_000 });
            await page.keyboard.press('Escape');
            step('once the page is deleted, search finds nothing');
        },
        // CB-308: page covers. Creates two pages and a file, so loopback only.
        async covers() {
            if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) {
                throw new Error('The covers scenario creates pages: loopback only.');
            }
            const api = await apiSignIn(base, admin);
            const { spaces } = await api('/workspace');
            const space = spaces[0].id;
            const stamp = Date.now();
            const covered = await api(`/spaces/${space}/pages`, 'POST', {
                title: `Covers ${stamp}`,
                content: [
                    'A page for the covers scenario: a wide image above the title.',
                    '',
                    '## What it is',
                    '',
                    'A band 200 px tall, inside the page’s reading width.',
                ].join('\n'),
            });
            createdPages.push([space, covered.id]);
            const plain = await api(`/spaces/${space}/pages`, 'POST', {
                title: `No cover ${stamp}`,
                content: 'A page without a cover: its card gets the page tile.',
            });
            createdPages.push([space, plain.id]);
            // Viewport screenshots, light and dark, with --shots.
            const shot = async (tab, name) => {
                if (!args.shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(args.shots, { recursive: true });
                for (const theme of ['light', 'dark']) {
                    await tab.evaluate((value) => {
                        document.documentElement.classList.toggle('dark', value === 'dark');
                    }, theme);
                    await tab.waitForTimeout(300);
                    await tab.screenshot({ path: `${args.shots}/${name}-${theme}.png` });
                    step(`screenshot ${name}-${theme}.png`);
                }
                await tab.evaluate(() =>
                    document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark'),
                );
            };
            await page.setViewportSize({ width: 1440, height: 900 });
            await goto(base);
            await signIn(admin);
            // The cover: hills drawn in the page, so nothing is fetched.
            const drawn = await page.evaluate(() => {
                const canvas = document.createElement('canvas');
                canvas.width = 1500;
                canvas.height = 500;
                const g = canvas.getContext('2d');
                const sky = g.createLinearGradient(0, 0, 0, 500);
                sky.addColorStop(0, '#a3d5c9');
                sky.addColorStop(1, '#e9e4cf');
                g.fillStyle = sky;
                g.fillRect(0, 0, 1500, 500);
                g.fillStyle = '#f7f1d8';
                g.beginPath();
                g.arc(1180, 130, 62, 0, Math.PI * 2);
                g.fill();
                const ridge = (color, points) => {
                    g.fillStyle = color;
                    g.beginPath();
                    g.moveTo(0, 500);
                    for (const [x, y] of points) {
                        g.lineTo(x, y);
                    }
                    g.lineTo(1500, 500);
                    g.fill();
                };
                ridge('#5f9e8d', [
                    [0, 330],
                    [200, 190],
                    [400, 280],
                    [600, 160],
                    [820, 290],
                    [1050, 200],
                    [1300, 300],
                    [1500, 230],
                ]);
                ridge('#3c7a6c', [
                    [0, 400],
                    [260, 300],
                    [520, 380],
                    [760, 290],
                    [1000, 370],
                    [1240, 320],
                    [1500, 380],
                ]);
                return canvas.toDataURL('image/png');
            });
            const png = Buffer.from(drawn.split(',')[1], 'base64');
            await goto(`${base}/spaces/${space}/pages/${covered.id}`);
            const title = page.locator('.document-title');
            await title.waitFor({ timeout: 30_000 });
            const add = page.getByRole('button', { name: 'Add cover' });
            await add.waitFor({ state: 'attached', timeout: 15_000 });
            const addOpacity = (want) =>
                page.waitForFunction(
                    (value) =>
                        getComputedStyle(document.querySelector('[data-slot="page-cover-add"] button')).opacity ===
                        value,
                    want,
                    { timeout: 5_000 },
                );
            await page.mouse.move(1400, 880);
            await addOpacity('0');
            await title.hover();
            await addOpacity('1');
            step('Add cover shows only on hovering the title');
            await shot(page, 'cover-add-desktop');
            await add.click();
            const picker = page.locator('[data-slot="cover-picker"]');
            await picker.getByText('Upload an image').waitFor({ timeout: 5_000 });
            await picker.getByText('From this Space').waitFor({ timeout: 5_000 });
            const uploaded = page.waitForResponse(
                (response) => new URL(response.url()).pathname === '/api/media/uploads' && response.status() === 201,
            );
            await page.locator('[data-slot="cover-file"]').setInputFiles({
                name: `cover-${stamp}.png`,
                mimeType: 'image/png',
                buffer: png,
            });
            createdFiles.push([admin, (await (await uploaded).json()).item.path]);
            const band = page.locator('[data-slot="page-cover"]');
            await page.waitForFunction(
                () => document.querySelector('[data-slot="page-cover"] img')?.naturalWidth > 0,
                undefined,
                { timeout: 15_000 },
            );
            await picker.waitFor({ state: 'detached', timeout: 5_000 });
            const height = (await band.boundingBox())?.height;
            if (height !== 200) {
                throw new Error(`The cover band is ${height}px tall`);
            }
            const set = (await api(`/spaces/${space}/pages/${covered.id}`)).cover;
            if (!set) {
                throw new Error('The server has no cover for the page');
            }
            step('an upload to Files becomes the cover: a 200 px band');
            await title.hover();
            await band.getByRole('button', { name: 'Remove' }).click();
            await band.waitFor({ state: 'detached', timeout: 5_000 });
            const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Cover removed' });
            await toast.getByRole('button', { name: 'Undo' }).click();
            await band.locator('img').waitFor({ timeout: 10_000 });
            if ((await api(`/spaces/${space}/pages/${covered.id}`)).cover?.id !== set.id) {
                throw new Error('Undo did not put the same cover back');
            }
            step('Remove, then the toast’s Undo puts the cover back');
            await title.hover();
            await band.getByRole('button', { name: 'Change cover' }).click();
            await picker.locator('[data-slot="cover-image"]').first().waitFor({ timeout: 10_000 });
            await page.waitForFunction(
                () => document.querySelector('[data-slot="cover-image"] img')?.naturalWidth > 0,
                undefined,
                { timeout: 10_000 },
            );
            await shot(page, 'cover-picker-desktop');
            await picker.locator('[data-slot="cover-image"]').first().click();
            await picker.waitFor({ state: 'detached', timeout: 10_000 });
            step('Change cover offers the Space’s images, and one is picked');
            await page.mouse.move(1400, 880);
            await page.waitForTimeout(300);
            await shot(page, 'cover-page-desktop');
            await goto(`${base}/spaces/${space}`);
            const card = (name) => page.locator('[data-slot="library-page-card"]').filter({ hasText: name });
            await card(`Covers ${stamp}`)
                .locator('[data-slot="library-card-band"][data-cover="image"]')
                .waitFor({ timeout: 15_000 });
            await card(`No cover ${stamp}`)
                .locator('[data-slot="library-card-band"][data-cover="tile"]')
                .waitFor({ timeout: 5_000 });
            await page.waitForFunction(
                () =>
                    [...document.querySelectorAll('[data-slot="library-card-band"] img')].every(
                        (img) => img.naturalWidth > 0,
                    ),
                undefined,
                { timeout: 10_000 },
            );
            step('the library gives every card a band: the cover, or the page tile');
            await shot(page, 'library-desktop');
            await page.setViewportSize({ width: 1280, height: 860 });
            // A phone: the controls show without hover, and nothing is wider than the screen.
            const phone = await guardEgress(
                await browser.newContext({
                    viewport: { width: 390, height: 844 },
                    deviceScaleFactor: 3,
                    isMobile: true,
                    hasTouch: true,
                    locale,
                    ignoreHTTPSErrors: args.insecure === 'true',
                }),
            );
            try {
                const tab = await phone.newPage();
                watch(tab);
                await goto(base, tab);
                if (admin.email) {
                    await tab.getByRole('textbox', { name: 'Email' }).fill(admin.email);
                    await tab.getByLabel('Password', { exact: true }).fill(admin.password);
                    await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
                } else {
                    await tab.getByRole('button', { name: `Continue as ${admin.name}` }).click({ timeout: 30_000 });
                }
                await tab.locator('[data-slot="app-header"]').waitFor({ timeout: 30_000 });
                await goto(`${base}/spaces/${space}/pages/${covered.id}`, tab);
                const phoneBand = tab.locator('[data-slot="page-cover"]');
                await tab.waitForFunction(
                    () => document.querySelector('[data-slot="page-cover"] img')?.naturalWidth > 0,
                    undefined,
                    { timeout: 15_000 },
                );
                const change = phoneBand.getByRole('button', { name: 'Change cover' });
                if ((await change.evaluate((element) => getComputedStyle(element).opacity)) !== '1') {
                    throw new Error('On a touch screen, Change cover is hidden');
                }
                const fits = async (what) => {
                    const fit = await tab.evaluate(mobileFit);
                    if (fit.overflow) {
                        throw new Error(`${what} makes the page ${fit.scrollWidth}px wide: ${fit.wide.join('; ')}`);
                    }
                };
                await fits('The page with a cover');
                await shot(tab, 'cover-page-phone');
                await change.click();
                const phonePicker = tab.locator('[data-slot="cover-picker"]');
                await phonePicker.locator('[data-slot="cover-image"]').first().waitFor({ timeout: 10_000 });
                await tab.waitForTimeout(300);
                const box = await phonePicker.boundingBox();
                if (!box || box.x < 0 || box.x + box.width > 390) {
                    throw new Error(`The picker is ${box && `${box.x}–${box.x + box.width}`}px on a 390px screen`);
                }
                await fits('The open picker');
                await shot(tab, 'cover-picker-phone');
                await tab.keyboard.press('Escape');
                await phonePicker.waitFor({ state: 'detached', timeout: 5_000 });
                await goto(`${base}/spaces/${space}`, tab);
                await tab
                    .locator('[data-slot="library-card-band"][data-cover="image"]')
                    .first()
                    .waitFor({ timeout: 15_000 });
                await fits('The library with bands');
                await shot(tab, 'library-phone');
                step('on a 390px phone the band, the picker and the library fit, with the controls shown');
            } finally {
                await phone.close();
            }
        },
        async links() {
            // Creates pages (and leaves tombstones of them), so it only runs on
            // loopback (a throwaway database). It needs no model.
            if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) {
                throw new Error('The links scenario creates pages: loopback only.');
            }
            const api = await apiSignIn(base, admin);
            const { spaces } = await api('/workspace');
            const space = spaces[0].id;
            const stamp = Date.now();
            const target = await api(`/spaces/${space}/pages`, 'POST', {
                title: `Link target ${stamp}`,
                content: 'The page a link points to.',
            });
            createdPages.push([space, target.id]);
            // Stored the old way: a hash route. It must open the path.
            const route = `#/spaces/${space}/pages/${target.id}`;
            const targetPath = `/spaces/${space}/pages/${target.id}`;
            const source = await api(`/spaces/${space}/pages`, 'POST', {
                title: `Links ${stamp}`,
                content: [
                    'Read [the docs](https://example.com/docs) first.',
                    '',
                    `Then see [the target page](/${route}).`,
                    '',
                    'Never follow [this](javascript:alert(1)).',
                ].join('\n'),
            });
            createdPages.push([space, source.id]);
            // Record window.open instead of opening tabs, so nothing leaves.
            await context.addInitScript(() => {
                window.__opened = [];
                window.open = (...call) => {
                    window.__opened.push(call);
                    return null;
                };
            });
            await goto(base);
            await signIn(admin);
            await goto(`${base}/#/spaces/${space}/pages/${source.id}`);
            await waitForPath(`/spaces/${space}/pages/${source.id}`);
            step('an old hash address opens the page at its path');
            const prose = page.locator('.document-prose');
            await prose.getByText('the docs').waitFor({ timeout: 30_000 });
            const opened = () => page.evaluate(() => window.__opened.splice(0));
            const hash = () => page.evaluate(() => location.pathname + location.hash);
            const before = await hash();

            await prose.getByText('the docs').click();
            const external = await opened();
            if (
                external.length !== 1 ||
                external[0][0] !== 'https://example.com/docs' ||
                external[0][1] !== '_blank' ||
                !/noopener/.test(external[0][2] ?? '')
            ) {
                throw new Error(`External link: ${JSON.stringify(external)}`);
            }
            if ((await hash()) !== before) {
                throw new Error('External link changed the app route');
            }
            step('external link opens in a new tab');

            await prose.getByText('this', { exact: true }).click();
            if ((await opened()).length || (await hash()) !== before) {
                throw new Error('A javascript: link was followed');
            }
            step('javascript: link is not followed');

            await prose.getByText('the target page').click({ modifiers: ['ControlOrMeta'] });
            const tab = await opened();
            if (tab.length !== 1 || tab[0][0] !== `${new URL(base).origin}${targetPath}`) {
                throw new Error(`Cmd/Ctrl+click on a page link: ${JSON.stringify(tab)}`);
            }
            step('Cmd/Ctrl+click opens a page link in a new tab');

            await prose.getByText('the docs').click({ button: 'middle' });
            const middle = await opened();
            if (middle.length !== 1 || middle[0][0] !== 'https://example.com/docs') {
                throw new Error(`Middle-click: ${JSON.stringify(middle)}`);
            }
            step('middle-click opens a new tab');

            // Shift+click selects instead of following.
            await prose.getByText('the docs').click({ modifiers: ['Shift'] });
            if ((await opened()).length) {
                throw new Error('Shift+click followed the link');
            }
            step('Shift+click selects text');

            await prose.getByText('the target page').click();
            await waitForPath(targetPath);
            await page.waitForFunction(
                (title) => document.querySelector('[data-slot="page-title"]')?.value === title,
                `Link target ${stamp}`,
                { timeout: 10_000 },
            );
            step('an old page link opens the page in the app, at its path');

            // Delete the target from its page menu; the confirm names it.
            const cards = (title) => page.locator('[data-slot="library-page-card"] h3', { hasText: title });
            await page.getByRole('button', { name: 'Page actions' }).click();
            await page.getByRole('menuitem', { name: 'Delete page' }).click();
            const confirm = page.getByRole('alertdialog');
            await confirm.getByText(`Delete “Link target ${stamp}”?`).waitFor({ timeout: 10_000 });
            await confirm.getByRole('button', { name: 'Delete page' }).click();
            await waitForPath(`/spaces/${space}`);
            await cards(`Links ${stamp}`).waitFor({ timeout: 10_000 });
            if (await cards(`Link target ${stamp}`).count()) {
                throw new Error('The library still lists the deleted page');
            }
            if ((await api(`/spaces/${space}/pages`)).some((item) => item.id === target.id)) {
                throw new Error('The server still lists the deleted page');
            }
            createdPages.splice(
                createdPages.findIndex(([, id]) => id === target.id),
                1,
            );
            step('a page deletes from its menu after a confirm; the Space drops it');

            await cards(`Links ${stamp}`).click();
            await waitForPath(`/spaces/${space}/pages/${source.id}`);
            await prose.getByText('the target page').click();
            await waitForPath(targetPath);
            await page.getByRole('heading', { name: 'This page was deleted' }).waitFor({ timeout: 10_000 });
            step('a link to the deleted page says it was deleted');

            await page.getByRole('button', { name: 'Back to all pages' }).click();
            await waitForPath(`/spaces/${space}`);
            await page.getByRole('button', { name: `Delete Links ${stamp}` }).click();
            await page.getByRole('alertdialog').getByRole('button', { name: 'Delete page' }).click();
            await page.getByRole('alertdialog').waitFor({ state: 'detached', timeout: 10_000 });
            await page.waitForFunction(
                (title) =>
                    ![...document.querySelectorAll('[data-slot="library-page-card"] h3')].some(
                        (item) => item.textContent === title,
                    ),
                `Links ${stamp}`,
                { timeout: 10_000 },
            );
            createdPages.splice(0);
            step('a page deletes from the library row action');
        },
        async shell() {
            await goto(base);
            await signIn(admin);
            await checkTheme();
            const sidebar = page.locator('[data-slot="sidebar"]').first();
            const inset = page.locator('[data-slot="sidebar-inset"]');
            const left = () => inset.evaluate((element) => element.getBoundingClientRect().left);
            const expectState = async (want) => {
                await page.waitForFunction(
                    (value) => document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state') === value,
                    want,
                    { timeout: 5_000 },
                );
                await page.waitForTimeout(300); // the width transition
            };
            // Start expanded whatever an earlier run left in the cookie.
            if ((await sidebar.getAttribute('data-state')) === 'collapsed') {
                await page.getByRole('button', { name: 'Expand sidebar' }).click();
            }
            await expectState('expanded');
            const wide = await left();
            await page.keyboard.press('ControlOrMeta+b');
            await expectState('collapsed');
            const narrow = await left();
            if (!(narrow < wide - 100)) {
                throw new Error(`Collapsing freed no space: ${wide} → ${narrow}`);
            }
            await reload();
            await header().waitFor({ timeout: 30_000 });
            await expectState('collapsed');
            if ((await left()) !== narrow) {
                throw new Error('The content moved after a reload while collapsed');
            }
            step('collapse frees the space and survives a reload');
            await page.getByRole('button', { name: 'Expand sidebar' }).click();
            await expectState('expanded');
            if ((await left()) !== wide) {
                throw new Error('Expanding did not restore the layout');
            }
            step('the toggle expands it again');

            const item = (name) => navItem(name, sidebar);
            const destinations = [
                ['Scheduled & activity', /A little follow-through/],
                ['Memories', /What your socios know about you/],
                ['Data', /What your socios keep for you/],
                ['Approvals', /Actions with side effects wait for you/],
                ['Schedules', /Recurring work your socios do for you/],
                ['Learning', /What your socios are learning/],
                ['Issues', /\d+ open · \d+ in progress · \d+ done/],
                ['Runs', /Recent turns across the team/],
            ];
            for (const [name, text] of destinations) {
                await item(name).click();
                await waitForText(text, 15_000);
                if ((await item(name).getAttribute('aria-current')) !== 'page') {
                    throw new Error(`${name} is not marked as the current page`);
                }
            }
            const { spaces, dots } = await (await apiSignIn(base, admin))('/workspace');
            await sidebar.getByRole('link', { name: spaces[0].name, exact: true }).click();
            await crumbs().getByText(spaces[0].name).waitFor({ timeout: 15_000 });
            await sidebar.getByRole('button', { name: `Expand ${spaces[0].name}` }).click();
            // A socio opens its home page (CB-89).
            await item(dots[0].name).click();
            await page.locator('[data-slot="dot-home"]').waitFor({ timeout: 15_000 });
            // Settings & setup opens the settings pages (CB-95), not a dialog.
            await item('Settings & setup').click();
            await waitForPath('/settings/workspace');
            await waitForText(/Your workspace, your rules/, 15_000);
            if ((await item('Settings & setup').getAttribute('aria-current')) !== 'page') {
                throw new Error('Settings & setup is not marked as the current page');
            }
            step('alice reaches every sidebar destination');

            // The launcher shows the modules each role can use.
            const telegramOn = (await (await apiSignIn(base, admin))('/workspace')).setup.telegram !== 'not_configured';
            const expectedCards = (asAdmin) => [
                'chat',
                'spaces',
                'activity',
                'memories',
                'data',
                'media',
                'approvals',
                'apps',
                'schedules',
                // Plugins: an admin's page (modules/plugins/module.ts).
                ...(asAdmin ? ['plugins'] : []),
                'learning',
                'issues',
                // Members have their own Runs (CB-128).
                'runs',
                ...(asAdmin ? ['dots', 'connected-agents'] : []),
                ...(telegramOn ? ['telegram'] : []),
                'settings',
                ...(asAdmin ? ['operations'] : []),
            ];
            const checkLauncher = async (asAdmin) => {
                await goto(base);
                await crumbs().getByText('Home').waitFor({ timeout: 15_000 });
                const cards = await launcherModules();
                if (JSON.stringify(cards) !== JSON.stringify(expectedCards(asAdmin))) {
                    throw new Error(`Launcher cards: ${JSON.stringify(cards)}`);
                }
                await page.locator('[data-slot="home-widget"]').first().waitFor({ timeout: 10_000 });
            };
            await checkLauncher(true);
            step('alice sees every module on the launcher, Runs included');
            // A module's header carries the header.actions slot (Report issue).
            await item('Memories').click();
            await waitForText(/What your socios know about you/, 15_000);
            await header()
                .locator('[data-slot="header-actions"]')
                .getByRole('button', { name: 'Report issue' })
                .waitFor({ timeout: 5_000 });
            await item('Issues').click();
            await waitForText(/\d+ open · \d+ in progress/, 15_000);
            if (await header().getByRole('button', { name: 'Report issue' }).count()) {
                throw new Error('Issues shows its own Report issue in the header');
            }
            step('the header.actions slot renders on module pages');
            // On a phone: the header is the title, the connection and ⋯ (More
            // options), which holds the other controls: Pause, the
            // header.actions slot's items (Report issue) and the rest.
            await item('Memories').click();
            await waitForText(/What your socios know about you/, 15_000);
            await page.setViewportSize({ width: 390, height: 844 });
            const more = header().getByRole('button', { name: /^More options/ });
            await more.waitFor({ timeout: 5_000 });
            for (const name of [/^(Pause|Resume) all socios$/, 'Report issue', 'Ask a socio', /^Help/, /computer$/]) {
                if (await header().getByRole('button', { name }).count()) {
                    throw new Error(`${name} is still in the phone header`);
                }
            }
            await more.click();
            const overflow = page.locator('[data-slot="header-overflow-menu"]');
            for (const name of [
                'Search',
                'Report issue',
                'Ask a socio',
                /^(Pause|Resume) all socios$/,
                /computer$/,
                'Help and guides',
                /^What’s new/,
                /^Keyboard shortcuts/,
            ]) {
                await overflow.getByRole('menuitem', { name }).waitFor({ timeout: 5_000 });
            }
            await page.keyboard.press('Escape');
            await overflow.waitFor({ state: 'detached', timeout: 5_000 });
            await page.setViewportSize({ width: 1280, height: 860 });
            step('on a phone, the header’s controls are in its ⋯ menu');

            await switchUser();
            await signIn(member);
            // Members have their own Runs (CB-128), and Learning is Skills.
            if (!(await item('Runs').count())) {
                throw new Error('Member is missing the Runs item');
            }
            if (await item('Learning').count()) {
                throw new Error('Member sees the Learning item');
            }
            // Members create their own socios (CB-31), and Spaces, which are
            // private to them (CB-181).
            if (!(await page.getByLabel('Create socio').count())) {
                throw new Error('Member is missing the Create socio control');
            }
            if (!(await page.getByLabel('Create Space').count())) {
                throw new Error('Member is missing the Create Space control');
            }
            await item('Skills').click();
            await waitForText(/Published skills|Skills\./, 15_000);
            await checkLauncher(false);
            step('bob sees no admin items, on the sidebar or the launcher, but Runs');

            await page.setViewportSize({ width: 390, height: 844 });
            await page.getByRole('button', { name: 'Open navigation' }).click();
            const sheet = page.locator('[data-slot="sidebar"][data-mobile="true"]');
            await sheet.waitFor({ timeout: 5_000 });
            await navItem('Memories', sheet).click();
            await sheet.waitFor({ state: 'detached', timeout: 5_000 });
            await waitForText(/What your socios know about you/, 15_000);
            step('the mobile sheet opens, navigates and closes');
            // Report issue is in the account menu: it closes the sheet and opens
            // the report dialog.
            await page.getByRole('button', { name: 'Open navigation' }).click();
            await sheet.waitFor({ timeout: 5_000 });
            await sheet.getByRole('button', { name: /^Account: / }).click();
            await page.getByRole('menuitem', { name: 'Report issue' }).click();
            const report = page.getByRole('dialog', { name: 'Report an issue' });
            await report.waitFor({ timeout: 5_000 });
            await sheet.waitFor({ state: 'detached', timeout: 5_000 });
            await page.keyboard.press('Escape');
            await report.waitFor({ state: 'detached', timeout: 5_000 });
            step('on a phone, Report issue opens from the account menu');
            await page.setViewportSize({ width: 1280, height: 860 });
        },
        // CB-96: an iPhone-sized phone (390×844, touch) visits each view and
        // dialog as alice and bob. A field under 16 px makes iOS zoom in when
        // it is focused, and the zoom stays in the installed app; a page wider
        // than the screen scrolls sideways. --routes home,chat,… scopes it.
        async 'mobile-fit'() {
            const api = await apiSignIn(base, admin);
            const { spaces, dots } = await api('/workspace');
            const space = spaces[0];
            let [pageInSpace] = await api(`/spaces/${space.id}/pages`);
            if (!pageInSpace && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) {
                pageInSpace = await api(`/spaces/${space.id}/pages`, 'POST', {
                    title: `Mobile fit ${Date.now()}`,
                    content: 'A page for the mobile-fit scenario.',
                });
                createdPages.push([space.id, pageInSpace.id]);
            }
            // CB-202: a page whose title is longer than the phone is wide.
            let longTitlePage;
            if (['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) {
                longTitlePage = await api(`/spaces/${space.id}/pages`, 'POST', {
                    title: 'Hugging Face Hub OpenUSD support — post and DFM analysis',
                    content: 'A page with a long title.',
                });
                createdPages.push([space.id, longTitlePage.id]);
            }
            const [issue] = await api('/issues/titles?open=true').catch(() => []);
            const dot = dots[0];
            const sheet = (tab) => tab.locator('[data-slot="sidebar"][data-mobile="true"]');
            const openSheet = async (tab) => {
                await tab.getByRole('button', { name: 'Open navigation' }).click();
                await sheet(tab).waitFor({ timeout: 5_000 });
                // Past the sheet's open animation.
                await tab.waitForTimeout(400);
            };
            // [name, a path or an action, admins only]. A path may depend on the
            // user; an action opens a dialog or a mode from the page it starts on.
            const views = [
                ['home', '/'],
                ['chat', (user) => user.thread && `/chats/${user.thread}`],
                // CB-107: long unbreakable lines in an approval card and a reply
                // (the scripted fake model's "smoke wide"; skipped with any other
                // model). The request is denied after.
                [
                    'chat-wide',
                    (user) =>
                        user.wide && {
                            from: `/chats/${user.wide}`,
                            open: async (tab) => {
                                await tab.getByLabel('Message your socio').fill('smoke wide, please');
                                await tab.getByLabel('Send message').click();
                                await tab
                                    .locator('[data-chat-message="assistant"]')
                                    .first()
                                    .waitFor({ timeout: 60_000 });
                                if (!(await tab.getByText('Smoke wide:').count())) {
                                    step('mobile-fit: chat-wide is not the scripted fake model');
                                    return;
                                }
                                await tab.locator('[data-slot="approval-card"]').first().waitFor({ timeout: 15_000 });
                                await tab.waitForTimeout(500);
                            },
                            close: async (tab) => {
                                const deny = tab
                                    .locator('[data-slot="approval-card"]')
                                    .getByRole('button', { name: 'Deny' });
                                if (await deny.count()) {
                                    await deny.first().click();
                                }
                            },
                        },
                    true,
                ],
                ['dot', dot && `/dots/${dot.id}`],
                ['new-chat', dot && `/dots/${dot.id}/new`],
                ['spaces', '/spaces'],
                ['space', `/spaces/${space.id}`],
                ['page', pageInSpace && `/spaces/${space.id}/pages/${pageInSpace.id}`],
                // CB-202: the long title wraps; none of it is cut off.
                [
                    'page-long-title',
                    longTitlePage && {
                        from: `/spaces/${space.id}/pages/${longTitlePage.id}`,
                        open: async (tab) => {
                            const title = tab.getByLabel('Page title');
                            await title.waitFor({ timeout: 10_000 });
                            const box = await title.evaluate((el) => ({
                                clipped: el.scrollHeight > el.clientHeight + 1,
                                lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)),
                            }));
                            if (box.clipped || box.lines < 2) {
                                throw new Error(
                                    `the page title is cut off or does not wrap (${box.lines} line(s), clipped: ${box.clipped})`,
                                );
                            }
                        },
                        close: async () => {},
                    },
                ],
                [
                    'page-source',
                    pageInSpace && {
                        from: `/spaces/${space.id}/pages/${pageInSpace.id}`,
                        open: async (tab) => {
                            await tab.getByRole('button', { name: 'Page actions' }).click();
                            await tab.getByRole('menuitem', { name: 'Markdown source' }).click();
                            await tab.getByLabel('Page Markdown').waitFor({ timeout: 5_000 });
                        },
                        close: async (tab) => {
                            await tab.getByRole('button', { name: 'Page actions' }).click();
                            await tab.getByRole('menuitem', { name: 'Visual editor' }).click();
                        },
                    },
                ],
                ['issues', '/issues'],
                ['issue', issue && `/issues/CB-${issue.number}`],
                ['schedules', '/schedules'],
                ['schedule', (user) => user.schedule && `/schedules/${user.schedule}`],
                ['activity', '/activity'],
                ['memories', '/memories'],
                ['learning', '/learning'],
                ['runs', '/runs', true],
                // A run's timeline: the first turn's trace, when there is one.
                [
                    'run-trace',
                    {
                        from: '/runs',
                        open: async (tab) => {
                            const trace = tab.getByRole('button', {
                                name: /^Show the trace/,
                            });
                            if (!(await trace.count())) {
                                return;
                            }
                            await trace.first().click();
                            await tab.waitForTimeout(800);
                        },
                        close: async () => {},
                    },
                    true,
                ],
                ['data', '/data'],
                // CB-162: the first dataset the user owns, with its settings, table
                // chips and rows.
                ['dataset', (user) => user.dataset && `/data/datasets/${user.dataset}`],
                ['media', '/media'],
                ['approvals', '/approvals'],
                ['apps', '/apps'],
                ['settings', '/settings'],
                ['operator', '/settings/operator', true],
                ['backend-editor', '/settings/operator/backends/new', true],
                ['settings-account', '/settings/account'],
                ['settings-inference', '/settings/inference'],
                ['settings-notifications', '/settings/notifications'],
                ['settings-people', '/settings/people', true],
                ['admin-dots', '/admin/dots', true],
                ['admin-dot', dot && `/admin/dots/${dot.id}`, true],
                ['admin-agents', '/admin/agents', true],
                ['connect', '/connect'],
                // CB-168: the release notes, and one release's page.
                ['releases', '/releases'],
                ['release', '/releases/v0.1.0'],
                [
                    'nav-sheet',
                    {
                        from: '/',
                        open: openSheet,
                        close: (tab) => tab.keyboard.press('Escape'),
                    },
                ],
                [
                    'report-issue',
                    {
                        from: '/',
                        open: async (tab) => {
                            await openSheet(tab);
                            await sheet(tab)
                                .getByRole('button', { name: /^Account: / })
                                .click();
                            await tab.getByRole('menuitem', { name: 'Report issue' }).click();
                            await tab.getByRole('dialog', { name: 'Report an issue' }).waitFor({ timeout: 5_000 });
                            await tab.waitForTimeout(400);
                        },
                        close: (tab) => tab.keyboard.press('Escape'),
                    },
                ],
                [
                    'dot-rename',
                    dot && {
                        from: '/',
                        open: async (tab) => {
                            await openSheet(tab);
                            await sheet(tab).locator('[data-dot-row] [aria-label$=" options"]').first().click();
                            await tab.getByRole('menuitem', { name: 'Rename' }).click();
                            await tab.waitForTimeout(400);
                        },
                        close: async (tab) => {
                            await tab.keyboard.press('Escape');
                            await tab.keyboard.press('Escape');
                        },
                    },
                    // A socio's ⋯ is for its owner and admins.
                    true,
                ],
                [
                    'dot-settings',
                    dot && {
                        from: '/',
                        open: async (tab) => {
                            await openSheet(tab);
                            await sheet(tab).locator('[data-dot-row] [aria-label$=" options"]').first().click();
                            await tab.getByRole('menuitem', { name: 'All settings…' }).click();
                            await tab.getByRole('dialog').first().waitFor({ timeout: 5_000 });
                            await tab.waitForTimeout(400);
                        },
                        close: (tab) => tab.keyboard.press('Escape'),
                    },
                    true,
                ],
                [
                    'palette',
                    {
                        from: '/',
                        open: async (tab) => {
                            await tab.keyboard.press('ControlOrMeta+k');
                            await tab.getByRole('dialog', { name: 'Search Socio' }).waitFor({ timeout: 5_000 });
                        },
                        close: (tab) => tab.keyboard.press('Escape'),
                    },
                ],
                // CB-166: the header's What's new list.
                [
                    'whats-new',
                    {
                        from: '/',
                        open: async (tab) => {
                            await whatsNewFromHelp(tab);
                            await tab.getByRole('dialog', { name: 'What’s new' }).waitFor({ timeout: 5_000 });
                            await tab.waitForTimeout(300);
                        },
                        close: (tab) => tab.keyboard.press('Escape'),
                    },
                ],
            ];
            const only = args.routes?.split(',');
            if (only) {
                for (const name of only) {
                    if (name !== 'sign-in' && !views.some(([view]) => view === name)) {
                        throw new Error(`Unknown mobile-fit route: ${name}`);
                    }
                }
            }
            const wanted = (name) => !only || only.includes(name);
            const problems = [];
            const table = [];
            const shot = async (tab, name) => {
                if (!args.shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(args.shots, { recursive: true });
                for (const theme of ['light', 'dark']) {
                    await tab.evaluate((value) => {
                        document.documentElement.classList.toggle('dark', value === 'dark');
                    }, theme);
                    await tab.screenshot({ path: `${args.shots}/${name}-${theme}.png` });
                }
                await tab.evaluate(() =>
                    document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark'),
                );
            };
            const record = async (tab, who, name) => {
                const fit = await tab.evaluate(mobileFit);
                const where = `${name} (${who.name})`;
                table.push({
                    view: name,
                    user: who.name,
                    path: await tab.evaluate(() => location.pathname),
                    overflow: fit.overflow ? `${fit.scrollWidth}px` : 'no',
                    small: fit.small.length,
                });
                if (fit.overflow) {
                    problems.push(
                        `${where}: ${fit.scrollWidth}px wide on a ${fit.width}px screen; past the edge: ${fit.wide.join('; ') || 'nothing found'}`,
                    );
                }
                if (fit.small.length) {
                    problems.push(`${where}: fields under 16px: ${fit.small.join('; ')}`);
                }
                if (fit.overflow || fit.small.length) {
                    await shot(tab, `${who.id}-${name}`);
                }
            };
            for (const user of [admin, member]) {
                const phone = await guardEgress(
                    await browser.newContext({
                        viewport: { width: 390, height: 844 },
                        deviceScaleFactor: 3,
                        isMobile: true,
                        hasTouch: true,
                        locale,
                        ignoreHTTPSErrors: args.insecure === 'true',
                    }),
                );
                const tab = await phone.newPage();
                watch(tab);
                await goto(base, tab);
                if (user === admin && wanted('sign-in')) {
                    const choice = user.email
                        ? tab.getByRole('textbox', { name: 'Email' })
                        : tab.getByRole('button', { name: `Continue as ${user.name}` });
                    await choice.waitFor({ timeout: 30_000 });
                    await record(tab, user, 'sign-in');
                }
                if (user.email) {
                    await tab.getByRole('textbox', { name: 'Email' }).fill(user.email);
                    await tab.getByLabel('Password', { exact: true }).fill(user.password);
                    await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
                } else {
                    await tab.getByRole('button', { name: `Continue as ${user.name}` }).click({ timeout: 30_000 });
                }
                await tab.getByRole('button', { name: 'Open navigation' }).waitFor({ timeout: 30_000 });
                // The user's own chat and schedule (another's answers 404).
                const own = await apiSignIn(base, user);
                const who = {
                    ...user,
                    thread: (await own('/workspace')).conversations[0]?.id,
                    schedule: (await own('/schedules').catch(() => ({}))).schedules?.[0]?.id,
                    dataset: (await own('/data').catch(() => ({}))).datasets?.find(
                        (dataset) => dataset.access === 'owner',
                    )?.id,
                };
                // A chat of its own for chat-wide, on loopback (made after the
                // newest chat above is picked).
                if (
                    user === admin &&
                    dot &&
                    wanted('chat-wide') &&
                    ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)
                ) {
                    const wide = await own('/conversations', 'POST', {
                        dotId: dot.id,
                        title: 'Mobile fit wide lines',
                    });
                    created.push({ userId: user.id, id: wide.id });
                    who.wide = wide.id;
                }
                for (const [name, target, adminOnly] of views) {
                    if (!wanted(name) || (adminOnly && user !== admin)) {
                        continue;
                    }
                    const to = typeof target === 'function' ? target(who) : target;
                    if (!to) {
                        step(`mobile-fit: ${name} skipped (nothing to open)`);
                        continue;
                    }
                    // A view that can't be opened is a problem too, and the rest
                    // still run.
                    try {
                        await goto(`${base}${typeof to === 'string' ? to : to.from}`, tab);
                        // Lazy parts (the editor, lists) settle.
                        await tab.waitForTimeout(800);
                        if (typeof to !== 'string') {
                            await to.open(tab);
                        }
                        await record(tab, who, name);
                        if (typeof to !== 'string') {
                            await to.close(tab);
                        }
                    } catch (error) {
                        problems.push(`${name} (${user.name}): could not open: ${error.message.split('\n')[0]}`);
                    }
                }
                await phone.close();
            }
            const pad = (text, size) => String(text).padEnd(size);
            for (const row of table) {
                step(
                    `mobile-fit: ${pad(row.view, 13)} ${pad(row.user, 6)} overflow ${pad(row.overflow, 6)} small fields ${row.small}  ${row.path}`,
                );
            }
            if (problems.length) {
                throw new Error(`${problems.length} mobile-fit problem(s):\n  ${problems.join('\n  ')}`);
            }
            step(`mobile-fit: ${table.length} views fit a 390px phone`);
        },
        async 'whats-new'() {
            const api = await apiSignIn(base, admin);
            const shots = args.shots;
            // Light and dark, at the tab's size.
            const shot = async (tab, name) => {
                if (!shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(shots, { recursive: true });
                for (const theme of ['light', 'dark']) {
                    await tab.evaluate((value) => {
                        document.documentElement.classList.toggle('dark', value === 'dark');
                    }, theme);
                    await tab.waitForTimeout(150);
                    await tab.screenshot({ path: `${shots}/${name}-${theme}.png` });
                }
                await tab.evaluate(() =>
                    document.documentElement.classList.toggle('dark', localStorage.getItem('theme') === 'dark'),
                );
                step(`screenshots ${name}-light.png, ${name}-dark.png`);
            };
            const { releases } = await api('/releases');
            if (!releases.length) {
                throw new Error('The server lists no releases');
            }
            const newest = releases[0].version;
            // Scrolls a list to its end until it holds every release (a page
            // loads as the end comes near).
            const scrollToAll = async (list, what) => {
                const cards = list.locator('[data-slot="release-card"]');
                const until = Date.now() + 15_000;
                while ((await cards.count()) < releases.length) {
                    if (Date.now() > until) {
                        throw new Error(`${what} stopped at ${await cards.count()} of ${releases.length} releases`);
                    }
                    await list.evaluate((node) => {
                        node.scrollTop = node.scrollHeight;
                        node.scrollIntoView({ block: 'end' });
                    });
                    await page.waitForTimeout(250);
                }
                if (await list.locator('[data-slot="release-feed-end"]').count()) {
                    throw new Error(`${what} still asks for more after the oldest`);
                }
            };
            // Someone who has seen nothing yet starts at the running version, the
            // newest: alice has seen the one before it, so the dot shows.
            if ((await api('/releases/seen')).lastSeen === null && releases[1]) {
                await api('/releases/seen', 'POST', { version: releases[1].version });
            }
            await page.setViewportSize({ width: 1440, height: 900 });
            await goto(base);
            await signIn(admin);
            const section = page.locator('[data-slot="home-whats-new"]');
            await section.waitFor({ timeout: 15_000 });
            const cards = section.locator('[data-slot="release-card"]');
            await cards.first().waitFor({ timeout: 15_000 });
            // Home shows the five most recent releases, fewer only if there
            // are fewer (CB-333), and links to the rest.
            const homeCards = Math.min(5, releases.length);
            const shown = await cards.count();
            if (shown !== homeCards) {
                throw new Error(`Home shows ${shown} release cards, not ${homeCards}`);
            }
            const homeVersions = await cards.evaluateAll((items) => items.map((item) => item.dataset.version));
            const newestVersions = releases.slice(0, homeCards).map((release) => release.version);
            if (homeVersions.join() !== newestVersions.join()) {
                throw new Error(`Home lists ${homeVersions.join(', ')}, not the newest ${newestVersions.join(', ')}`);
            }
            if (
                (await cards.first().getAttribute('data-version')) !== newest ||
                (await section.getByRole('link', { name: 'All releases' }).getAttribute('href')) !== '/releases'
            ) {
                throw new Error('Home’s What’s new is not the newest releases');
            }
            step(`Home lists ${shown} releases, newest ${newest}, and All releases`);
            // Beside the apps, the list scrolls in its own box, at most 34rem.
            const list = section.locator('[data-slot="home-whats-new-list"]');
            const box = await list.boundingBox();
            if (!box || box.height > 34 * 16 + 2) {
                throw new Error(`Home’s list is ${box?.height}px tall`);
            }
            // What's new is in the header's Help menu (CB-308).
            const button = header().getByRole('button', { name: /^Help/ });
            const dot = page.locator('[data-slot="whats-new-dot"]');
            const hadDot = (await dot.count()) > 0;
            await page.locator('[data-slot="home-whats-new"]').scrollIntoViewIfNeeded();
            await shot(page, 'whats-new-home-desktop');
            // Capped: no load-more sentinel, and scrolling to the end loads no
            // more (the header's list still does, below).
            if (await list.locator('[data-slot="release-feed-end"]').count()) {
                throw new Error('Home’s list asks for more past its five');
            }
            await list.evaluate((node) => {
                node.scrollTop = node.scrollHeight;
                node.scrollIntoView({ block: 'end' });
            });
            await page.waitForTimeout(1_000);
            if ((await cards.count()) !== homeCards) {
                throw new Error(`Home’s list grew to ${await cards.count()} cards as it scrolled`);
            }
            step(`Home’s list stays at ${homeCards} as it scrolls; All releases has the rest`);
            await list.evaluate((node) => (node.scrollTop = 0));
            // From the keyboard: focus, Enter, focus inside, Escape back.
            await button.focus();
            await page.keyboard.press('Enter');
            const item = page.getByRole('menuitem', { name: /^What’s new/ });
            await item.waitFor({ timeout: 5_000 });
            await item.focus();
            await page.keyboard.press('Enter');
            const menu = page.getByRole('dialog', { name: 'What’s new' });
            await menu.waitFor({ timeout: 5_000 });
            if (!(await menu.evaluate((node) => node.contains(document.activeElement)))) {
                throw new Error('Focus did not move into the What’s new list');
            }
            const listed = await menu.locator('[data-slot="release-card"]').count();
            if (listed < 1) {
                throw new Error('The header lists no releases');
            }
            await page.waitForTimeout(300);
            await shot(page, 'whats-new-menu-desktop');
            // The same list, scrolled in the popover.
            await scrollToAll(menu.locator('[data-slot="whats-new-list"]'), 'The header’s list');
            const until = Date.now() + 5_000;
            while ((await api('/releases/seen')).lastSeen !== newest) {
                if (Date.now() > until) {
                    throw new Error(`Opening the list didn’t mark ${newest} seen`);
                }
                await page.waitForTimeout(200);
            }
            if (await dot.count()) {
                throw new Error('The unread dot stayed');
            }
            await page.keyboard.press('Escape');
            await menu.waitFor({ state: 'detached', timeout: 5_000 });
            if (!(await button.evaluate((node) => node === document.activeElement))) {
                throw new Error('Focus did not come back to Help');
            }
            step(
                `the header lists ${listed} from the keyboard and marks ${newest} seen${hadDot ? ' (its dot went)' : ''}`,
            );
            // The cards shown long enough were recorded, for support: admins
            // read them per person.
            const viewsUntil = Date.now() + 10_000;
            let views = [];
            while (
                !(views = (await api(`/admin/people/${admin.id}/releases`)).views).some(
                    (view) => view.version === newest,
                )
            ) {
                if (Date.now() > viewsUntil) {
                    throw new Error(`${newest} was never recorded as shown`);
                }
                await page.waitForTimeout(500);
            }
            step(`the releases shown are recorded: ${views.length} for ${admin.name}`);
            // A phone: the socios stay above the fold, the list fits the screen.
            const phone = await guardEgress(
                await browser.newContext({
                    viewport: { width: 390, height: 844 },
                    deviceScaleFactor: 3,
                    isMobile: true,
                    hasTouch: true,
                    locale,
                    ignoreHTTPSErrors: args.insecure === 'true',
                }),
            );
            try {
                const tab = await phone.newPage();
                watch(tab);
                await goto(base, tab);
                if (admin.email) {
                    await tab.getByRole('textbox', { name: 'Email' }).fill(admin.email);
                    await tab.getByLabel('Password', { exact: true }).fill(admin.password);
                    await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
                } else {
                    await tab.getByRole('button', { name: `Continue as ${admin.name}` }).click({ timeout: 30_000 });
                }
                await tab.locator('[data-slot="home-whats-new"]').waitFor({ timeout: 30_000 });
                const firstDot = await tab.locator('[data-slot="dot-card"]').first().boundingBox();
                if (!firstDot || firstDot.y + firstDot.height > 844) {
                    throw new Error('On a phone the socios are below the fold');
                }
                await shot(tab, 'whats-new-home-phone');
                await tab.locator('[data-slot="home-whats-new"]').scrollIntoViewIfNeeded();
                await shot(tab, 'whats-new-home-phone-section');
                await whatsNewFromHelp(tab);
                const list = tab.getByRole('dialog', { name: 'What’s new' });
                await list.waitFor({ timeout: 5_000 });
                await tab.waitForTimeout(300);
                const box = await list.boundingBox();
                if (!box || box.x < 0 || box.x + box.width > 390) {
                    throw new Error(`The list is ${box && `${box.x}–${box.x + box.width}`}px on a 390px screen`);
                }
                const fit = await tab.evaluate(mobileFit);
                if (fit.overflow) {
                    throw new Error(`The open list makes the page ${fit.scrollWidth}px wide: ${fit.wide.join('; ')}`);
                }
                await shot(tab, 'whats-new-menu-phone');
                step('on a 390px phone the socios stay above the fold and the list fits');
            } finally {
                await phone.close();
            }
            // A 360 px phone, an admin in a chat: the header is the title, one
            // status indicator (the connection) and ⋯ (More options), which
            // holds Pause, What's new and the rest; the title keeps at least
            // 100 px.
            const { dots } = await api('/workspace');
            const chat = await api('/conversations', 'POST', {
                dotId: dots[0].id,
                title: 'A chat whose title should keep its room in the header',
            });
            created.push({ userId: admin.id, id: chat.id });
            const small = await guardEgress(
                await browser.newContext({
                    viewport: { width: 360, height: 740 },
                    deviceScaleFactor: 3,
                    isMobile: true,
                    hasTouch: true,
                    locale,
                    ignoreHTTPSErrors: args.insecure === 'true',
                }),
            );
            try {
                const tab = await small.newPage();
                watch(tab);
                await goto(base, tab);
                if (admin.email) {
                    await tab.getByRole('textbox', { name: 'Email' }).fill(admin.email);
                    await tab.getByLabel('Password', { exact: true }).fill(admin.password);
                    await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
                } else {
                    await tab.getByRole('button', { name: `Continue as ${admin.name}` }).click({ timeout: 30_000 });
                }
                await tab.getByRole('button', { name: 'Open navigation' }).waitFor({ timeout: 30_000 });
                await goto(`${base}/chats/${chat.id}`, tab);
                const title = tab.locator('[data-slot="app-header"] [data-slot="chat-title"]');
                await title.waitFor({ timeout: 15_000 });
                const header = tab.locator('[data-slot="app-header"]');
                const status = header.locator(
                    '[data-slot="connection-indicator"]:visible, [data-slot="connection-badge"]:visible',
                );
                if ((await status.count()) !== 1) {
                    throw new Error(`The header shows ${await status.count()} status indicators at 360 px`);
                }
                for (const name of [/^Pause all|^Resume all/, /^Help/, 'Chat options']) {
                    if (await header.getByRole('button', { name }).count()) {
                        throw new Error(`The header still shows ${name} at 360 px`);
                    }
                }
                const width = (await title.boundingBox())?.width ?? 0;
                if (width < 100) {
                    throw new Error(`At 360 px the chat title has ${width}px`);
                }
                const box = await header.boundingBox();
                const fits = await header.evaluate((node) => node.scrollWidth <= node.clientWidth);
                if (!box || box.x + box.width > 360 || !fits) {
                    throw new Error('At 360 px the header is wider than the screen');
                }
                await shot(tab, 'whats-new-header-360');
                await header.getByRole('button', { name: /^More options/ }).click();
                const overflow = tab.locator('[data-slot="header-overflow-menu"]');
                for (const name of [/^Pause all|^Resume all/, /^What’s new/, 'Rename']) {
                    await overflow.getByRole('menuitem', { name }).waitFor({ timeout: 5_000 });
                }
                await shot(tab, 'whats-new-header-menu-360');
                await tab.keyboard.press('Escape');
                await overflow.waitFor({ state: 'detached', timeout: 5_000 });
                step(`at 360 px an admin's chat title keeps ${Math.round(width)}px; Pause and What's new are in ⋯`);
            } finally {
                await small.close();
            }
        },
        async tabs() {
            // Two tabs of one browser profile: one context, one session cookie.
            await goto(base);
            await signIn(admin);
            const other = await context.newPage();
            watch(other);
            const asked = { a: 0, b: 0 };
            const count = (tab) => (request) => {
                if (new URL(request.url()).pathname === '/api/state') {
                    asked[tab] += 1;
                }
            };
            const countA = count('a');
            page.on('request', countA);
            other.on('request', count('b'));
            await goto(base, other);
            const named = (tab) => tab.locator('[data-slot="sidebar-footer"]').getByText(admin.name);
            await named(other).waitFor({ timeout: 30_000 });
            // A mark a reload would lose.
            await other.evaluate(() => {
                globalThis.smokeTab = 'kept';
            });
            const notReloaded = async () => {
                if ((await other.evaluate(() => globalThis.smokeTab)) !== 'kept') {
                    throw new Error('Tab B reloaded');
                }
            };
            // Mock auth's picker, or Better Auth's form.
            const signInScreen = (tab) => tab.getByText(/Who’s thinking today\?|Welcome back\./).first();
            await switchUser();
            const signedOutAt = Date.now();
            await signInScreen(page).waitFor({ timeout: 10_000 });
            await signInScreen(other).waitFor({ timeout: 5_000 });
            const followed = Date.now() - signedOutAt;
            if (await other.locator('[data-slot="sidebar"]').count()) {
                throw new Error('Tab B still shows the sidebar');
            }
            await notReloaded();
            step(`signed out in tab A: tab B shows sign-in without a reload (${followed} ms)`);
            asked.a = 0;
            asked.b = 0;
            await other.waitForTimeout(10_000);
            if (asked.a || asked.b) {
                throw new Error(`Signed out, the tabs asked /api/state ${asked.a} and ${asked.b} times in 10 s`);
            }
            step('signed out, neither tab asks /api/state for 10 s');
            const signedInAt = Date.now();
            await signIn(admin);
            await named(other).waitFor({ timeout: 10_000 });
            await notReloaded();
            step(`signed in in tab A: tab B is back in the shell without a reload (${Date.now() - signedInAt} ms)`);
            page.off('request', countA);
            await tabWrites(other, notReloaded);
            await other.close();
        },
        async routes() {
            const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname);
            const api = await apiSignIn(base, admin);
            const { spaces, dots, conversations } = await api('/workspace');
            const space = spaces[0];
            let [pageInSpace] = await api(`/spaces/${space.id}/pages`);
            if (!pageInSpace && loopback) {
                pageInSpace = await api(`/spaces/${space.id}/pages`, 'POST', {
                    title: `Routes ${Date.now()}`,
                    content: 'A page for the routes scenario.',
                });
            }
            await goto(base);
            await signIn(admin);
            const crumb = async () =>
                (await crumbs().locator('[data-slot="breadcrumb-page"]').innerText()).trim().replace(/\s+/g, ' ');
            // Each view by its address, then again after a reload.
            const views = [
                ['/', 'Home', /Your socios/],
                [`/dots/${dots[0].id}`, dots[0].name, null],
                [`/dots/${dots.at(-1).id}`, dots.at(-1).name, null],
                ['/activity', 'Activity', /A little follow-through/],
                ['/memories', 'Memories', /What your socios know about you/],
                ['/data', 'Data', /What your socios keep for you/],
                ['/media', 'Media', /Files you and your socios keep/],
                ['/approvals', 'Approvals', /Actions with side effects wait for you/],
                ['/schedules', 'Schedules & jobs', /Recurring work your socios do for you/],
                ['/learning', 'Learning', /What your socios are learning/],
                ['/issues', 'Issues', /\d+ open · \d+ in progress · \d+ done/],
                ['/runs', 'Runs', /Recent turns across the team/],
                [`/spaces/${space.id}`, 'Pages', null],
                ['/no/such/view', 'Not found', /Page not found/],
            ];
            // A page's crumb is its title (CB-38); the library's is Pages.
            const pageCrumb = pageInSpace?.title.trim() || 'Untitled page';
            if (pageInSpace) {
                views.push([`/spaces/${space.id}/pages/${pageInSpace.id}`, pageCrumb, null]);
            }
            if (conversations[0]) {
                views.push([`/chats/${conversations[0].id}`, null, null]);
            }
            const pageTitle = (title) =>
                page.waitForFunction(
                    (title) => document.querySelector('[data-slot="page-title"]')?.value === title,
                    title,
                    { timeout: 15_000 },
                );
            const check = (path, title, text) =>
                checkView(path, title, text).catch(async (error) => {
                    throw new Error(
                        `${path} (at ${await pathname()}, crumb ${JSON.stringify(await crumb().catch(() => ''))}): ${error.message}`,
                    );
                });
            const checkView = async (path, title, text) => {
                await waitForPath(path);
                await hydrated();
                if (text) {
                    await waitForText(text, 15_000);
                }
                if (title) {
                    await page.waitForFunction(
                        (want) => document.querySelector('[data-slot="breadcrumb-page"]')?.textContent?.trim() === want,
                        title,
                        { timeout: 15_000 },
                    );
                }
            };
            for (const [path, title, text] of views) {
                // An unknown address answers 404, which the browser logs.
                const status = title === 'Not found' ? 404 : 200;
                tolerated = status === 404 ? /status of 404/ : undefined;
                const loaded = await goto(`${base}${path}`);
                if (loaded.status() !== status) {
                    throw new Error(`${path} answered ${loaded.status()}`);
                }
                await check(path, title, text);
                await reload();
                await check(path, title, text);
                tolerated = undefined;
                if (pageInSpace && path.endsWith(`/pages/${pageInSpace.id}`)) {
                    await pageTitle(pageInSpace.title);
                }
            }
            step(`reload keeps each of ${views.length} views`);

            // Back and forward walk the same views; the sidebar follows.
            const walk = ['/activity', '/memories', `/spaces/${space.id}`];
            await goto(`${base}/`);
            await check('/', null, null);
            for (const path of walk) {
                await navItem(
                    path === '/activity' ? 'Scheduled & activity' : path === '/memories' ? 'Memories' : space.name,
                ).click();
                await waitForPath(path);
            }
            for (const path of [...walk].reverse().slice(1).concat('/')) {
                await page.goBack();
                await waitForPath(path);
            }
            await page.goForward();
            await check('/activity', 'Activity', /A little follow-through/);
            if ((await navItem('Scheduled & activity').getAttribute('aria-current')) !== 'page') {
                throw new Error('The sidebar does not follow back/forward');
            }
            step('back and forward work, and the sidebar follows');

            // ⌘K / Ctrl+K: find a page (or a module) by name and open it.
            if (pageInSpace) {
                await paletteOpen(
                    pageInSpace.title,
                    new RegExp(pageInSpace.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
                );
                await waitForPath(`/spaces/${space.id}/pages/${pageInSpace.id}`);
                await pageTitle(pageInSpace.title);
                step('the palette finds a page and opens it');
            }
            await paletteOpen('memories', /Go to Memories/);
            await check('/memories', 'Memories', /What your socios know about you/);
            step('the palette opens a module');

            // Old hash links: a Space and, if there is one, a page.
            await goto(`${base}/#/spaces/${space.id}`);
            await check(`/spaces/${space.id}`, 'Pages', null);
            if ((await crumbs().innerText()).indexOf(space.name) < 0) {
                throw new Error(`An old Space link opened ${await crumb()}`);
            }
            if (pageInSpace) {
                await goto(`${base}/#/spaces/${space.id}/pages/${pageInSpace.id}`);
                await check(`/spaces/${space.id}/pages/${pageInSpace.id}`, pageCrumb, null);
                await pageTitle(pageInSpace.title);
            }
            if (await page.evaluate(() => location.hash)) {
                throw new Error('The old hash stayed in the address bar');
            }
            step('old hash links open the right page at its path');

            await switchUser();
            await signIn(member);
            // Members have their own Runs (CB-128): their turns, not the team's.
            const sent = await goto(`${base}/runs`);
            if (sent?.request().redirectedFrom()) {
                throw new Error('/runs redirected bob');
            }
            await check('/runs', 'Runs', /Your recent turns with socios/);
            const runs = page.locator('[data-slot="runs-page"]');
            if (/Recent turns across the team/.test(await runs.innerText())) {
                throw new Error('bob sees the team’s turns');
            }
            if (!(await navItem('Runs').count())) {
                throw new Error('Member is missing the Runs item');
            }
            step('bob opens his own turns at /runs');
        },
        async ssr() {
            // What the server renders (CB-61), without JavaScript: the page
            // and its serialized data are all there is.
            // Nothing hydrates here, so its loads skip the hydration wait.
            const bare = await guardEgress(
                await browser.newContext({
                    javaScriptEnabled: false,
                    viewport: { width: 1280, height: 860 },
                    locale,
                    ignoreHTTPSErrors: args.insecure === 'true',
                }),
            );
            const plain = await bare.newPage();
            const open = async (path, status = 200) => {
                const response = await plain.goto(`${base}${path}`);
                if (response.status() !== status) {
                    throw new Error(`${path} answered ${response.status()}`);
                }
                const headers = response.headers();
                if (!/script-src 'self' 'nonce-[^']+'/.test(headers['content-security-policy'])) {
                    throw new Error(`${path} has no nonce in its CSP`);
                }
                if (headers['cache-control'] !== 'no-store') {
                    throw new Error(`${path} is cacheable: ${headers['cache-control']}`);
                }
                return response;
            };
            const sidebar = plain.locator('[data-slot="sidebar"]');
            const html = () => plain.content();
            // The browser context's session, for the page without JavaScript.
            const as = async (user) => {
                await goto(base);
                if (current) {
                    await switchUser();
                }
                await signIn(user);
                await bare.clearCookies();
                await bare.addCookies(await context.cookies());
            };
            try {
                await open('/memories');
                await plain.getByText(/Who’s thinking today\?|Welcome back\./).waitFor({ timeout: 5_000 });
                if (await sidebar.count()) {
                    throw new Error('Signed out with a sidebar');
                }
                const signedOut = await html();
                for (const user of [admin, member]) {
                    if (signedOut.includes(user.name)) {
                        throw new Error(`The signed-out page names ${user.name}`);
                    }
                }
                step('signed out: the sign-in screen at the address, no names');

                const api = await apiSignIn(base, admin);
                const { dots } = await api('/workspace');
                const mine = await api('/conversations', 'POST', {
                    dotId: dots[0].id,
                    title: `SSR smoke ${Date.now()}`,
                });
                created.push({ userId: admin.id, id: mine.id });
                // Alice's own: a Telegram team topic is shared with its members.
                const conversations = (await api('/workspace')).conversations.filter((item) => !item.team);
                await as(admin);
                await open('/');
                await sidebar.first().waitFor({ timeout: 5_000 });
                await sidebar.getByText(mine.title).waitFor({ timeout: 5_000 });
                await sidebar.locator('[data-slot="sidebar-footer"]').getByText(admin.name).waitFor({ timeout: 5_000 });
                // Home's line of counts (CB-308), from alice's own workspace.
                await plain
                    .locator('[data-slot="home-subtitle"]')
                    .getByText(/^\d+ socios?( · |$)/)
                    .waitFor({ timeout: 5_000 });
                const cards = await plain
                    .locator('[data-slot="module-card"]')
                    .evaluateAll((items) => items.map((card) => card.dataset.module));
                if (!cards.includes('runs') || !cards.includes('memories')) {
                    throw new Error(`Launcher cards: ${JSON.stringify(cards)}`);
                }
                if (!(await html()).includes('dataKey')) {
                    throw new Error('The admin page data has no admin setup');
                }
                step(`alice: the sidebar, ${cards.length} launcher cards and her name`);
                await open('/memories');
                await plain.getByText('What your socios know about you').waitFor({ timeout: 5_000 });
                await open('/activity');
                await plain.getByText('A little follow-through').waitFor({
                    timeout: 5_000,
                });
                await open('/no/such/page', 404);
                await plain.getByText('Page not found').waitFor({ timeout: 5_000 });
                await sidebar.first().waitFor({ timeout: 5_000 });
                step('Memories and Activity rendered; an unknown address is a 404');

                // A link from another site (web mail, Telegram Web): the browser
                // leaves the SameSite=Strict session cookie out, so the server
                // opens the page again from this site, with JavaScript (a reload
                // that keeps the #hash) and without (a meta refresh).
                for (const [label, tab] of [
                    ['with JavaScript', await context.newPage()],
                    ['without', await bare.newPage()],
                ]) {
                    const elsewhere = 'https://elsewhere.example';
                    await tab.route(`${elsewhere}/**`, (route) =>
                        route.fulfill({
                            contentType: 'text/html',
                            body: `<a href="${base}/memories#top">Memories</a>`,
                        }),
                    );
                    if (label === 'with JavaScript') {
                        watch(tab);
                    }
                    const loads = [];
                    tab.on('response', (response) => {
                        if (response.request().isNavigationRequest() && response.url().startsWith(base)) {
                            loads.push(response.status());
                        }
                    });
                    try {
                        await tab.goto(`${elsewhere}/mail`);
                        // Without JavaScript the hash stays behind (the server never
                        // sees it).
                        const hash = label === 'without' ? '' : '#top';
                        await tab.getByRole('link', { name: 'Memories' }).click();
                        await tab.getByText('What your socios know about you').waitFor({ timeout: 10_000 });
                        await tab
                            .locator('[data-slot="sidebar-footer"]')
                            .getByText(admin.name)
                            .waitFor({ timeout: 5_000 });
                        if (label === 'with JavaScript') {
                            await hydrated(tab);
                        }
                        if (loads.length !== 2 || new URL(tab.url()).hash !== hash) {
                            throw new Error(`${JSON.stringify(loads)} at ${tab.url()}`);
                        }
                    } catch (error) {
                        throw new Error(`A link from another site (${label}): ${error.message}`);
                    } finally {
                        await tab.close();
                    }
                }
                step('a link from another site opens the page signed in');

                await as(member);
                await open('/');
                await sidebar
                    .locator('[data-slot="sidebar-footer"]')
                    .getByText(member.name)
                    .waitFor({ timeout: 5_000 });
                const markup = await html();
                const leaked = conversations.filter((item) => markup.includes(item.id));
                if (leaked.length || markup.includes(mine.title)) {
                    throw new Error(`bob's page has alice's chats`);
                }
                if (markup.includes('dataKey')) {
                    throw new Error("bob's page data has the admin setup");
                }
                // Members have their own Runs (CB-128).
                if (!(await plain.locator('[data-slot="module-card"][data-module="runs"]').count())) {
                    throw new Error('bob is missing the Runs card');
                }
                if (!(await sidebar.getByRole('link', { name: 'Runs', exact: true }).count())) {
                    throw new Error('bob is missing the Runs item');
                }
                const sent = await open('/runs');
                if (sent.request().redirectedFrom() || new URL(plain.url()).pathname !== '/runs') {
                    throw new Error(`/runs left bob at ${plain.url()}`);
                }
                await plain.getByText('Your recent turns with socios').waitFor({ timeout: 5_000 });
                if ((await html()).includes('Recent turns across the team')) {
                    throw new Error('bob’s Runs has the team’s turns');
                }
                step(
                    `bob: his own page, none of alice's ${conversations.length} chats, no admin setup; /runs his own turns`,
                );
            } finally {
                await bare.close();
            }
        },
        async skew() {
            // A tab still on the previous build after a deploy (CB-61): its
            // chunks are gone and its route manifest is out of date.
            const sidebar = page.locator('[data-slot="sidebar"]').first();
            // The page loading itself again (a stale build): its load event, then
            // hydration, before the next click.
            const reloaded = () => page.waitForEvent('load', { timeout: 15_000 }).then(() => hydrated());
            await goto(base);
            await signIn(admin);
            await page.waitForLoadState('networkidle');
            // 1. A page's code is gone (404): React Router loads the page again,
            // and the next click lands on the new build.
            let gone = 0;
            await page.route('**/assets/MemoriesPage.route-*.js', (route) => {
                if (gone++) {
                    return route.continue();
                }
                return route.fulfill({ status: 404, body: 'Not found.' });
            });
            tolerated = /Error loading route module|Failed to fetch dynamically imported module|status of 404/;
            let load = reloaded();
            await navItem('Memories', sidebar).click();
            await load;
            if (gone !== 1) {
                throw new Error(`The chunk was asked for ${gone} times`);
            }
            await sidebar.waitFor({ timeout: 15_000 });
            await navItem('Memories', sidebar).click();
            await waitForText(/What your socios know about you/, 15_000);
            await page.unroute('**/assets/MemoriesPage.route-*.js');
            tolerated = undefined;
            step('a missing page chunk loads the page again, then the click lands');
            // 2. The server's route manifest is newer: the next click into an
            // undiscovered route loads its address as a page.
            await page.route(`**/__manifest?*`, (route) =>
                route.fulfill({
                    status: 204,
                    headers: { 'X-Remix-Reload-Document': 'true' },
                }),
            );
            await goto(base);
            await sidebar.waitFor({ timeout: 15_000 });
            await page.waitForLoadState('networkidle');
            load = reloaded();
            await navItem('Data', sidebar).click();
            await load;
            await page.unroute(`**/__manifest?*`);
            await waitForPath('/data');
            await waitForText(/What your socios keep for you/, 15_000);
            step('a newer route manifest loads the target as a page');
            // 3. Before the click (step 5): every link on the page is known to
            // the router, so only the tab's own check can tell it is stale.
            // Brought back into view, it asks; then a click, and the palette,
            // load their page from the server.
            const discovered = (response) => {
                const url = new URL(response.url());
                return url.pathname === '/__manifest' && url.searchParams.get('paths') === '/';
            };
            // Route discovery's own requests while stale, by the paths asked,
            // and how many came before the page load.
            let asked = [];
            let askedFirst = 0;
            // A page load of `path`: its document request, then its load event.
            const loadsPage = (path) =>
                Promise.all([
                    page.waitForRequest(
                        (request) => {
                            const found = request.isNavigationRequest() && new URL(request.url()).pathname === path;
                            if (found) {
                                askedFirst = asked.length;
                            }
                            return found;
                        },
                        { timeout: 15_000 },
                    ),
                    reloaded(),
                ]);
            const backInView = async () => {
                await sidebar.waitFor({ timeout: 15_000 });
                await page.waitForLoadState('networkidle');
                await page.route(`**/__manifest?*`, (route) => {
                    asked.push(new URL(route.request().url()).searchParams.get('paths'));
                    return route.fulfill({
                        status: 204,
                        headers: { 'X-Remix-Reload-Document': 'true' },
                    });
                });
                const check = page.waitForResponse(discovered, { timeout: 10_000 });
                await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
                await check;
                asked = [];
            };
            await goto(base);
            await backInView();
            let landed = loadsPage('/issues');
            await navItem('Issues', sidebar).click();
            await landed;
            await page.unroute(`**/__manifest?*`);
            await waitForPath('/issues');
            await waitForText(/\d+ open · \d+ in progress · \d+ done/, 15_000);
            if (askedFirst) {
                throw new Error(`The router asked about routes first: ${asked}`);
            }
            step('back in view, the stale tab loads Issues from the server');
            await backInView();
            landed = loadsPage('/memories');
            await paletteOpen('memories', /Go to Memories/);
            await landed;
            await page.unroute(`**/__manifest?*`);
            await waitForText(/What your socios know about you/, 15_000);
            step('and the palette loads Memories from the server');
            // A deploy while the tab is in view: the shell's poll fails while the
            // server is away, and its first answer after that makes the tab ask
            // about its build, so the next click loads its page.
            await sidebar.waitFor({ timeout: 15_000 });
            await page.waitForLoadState('networkidle');
            tolerated = /net::ERR_FAILED/;
            await page.route('**/api/state', (route) => route.abort());
            await page.waitForEvent('requestfailed', {
                predicate: (request) => new URL(request.url()).pathname === '/api/state',
                timeout: 10_000,
            });
            await page.route(`**/__manifest?*`, (route) => {
                asked.push(new URL(route.request().url()).searchParams.get('paths'));
                return route.fulfill({
                    status: 204,
                    headers: { 'X-Remix-Reload-Document': 'true' },
                });
            });
            const afterOutage = page.waitForResponse(discovered, { timeout: 10_000 });
            await page.unroute('**/api/state');
            await afterOutage;
            tolerated = undefined;
            asked = [];
            landed = loadsPage('/data');
            await navItem('Data', sidebar).click();
            await landed;
            await page.unroute(`**/__manifest?*`);
            await waitForText(/What your socios keep for you/, 15_000);
            if (askedFirst) {
                throw new Error(`The router asked about routes first: ${asked}`);
            }
            step('back after the server was away, the stale tab loads Data from it');
            // 4. The editor's chunk fails once (Vite's preload error): one reload.
            const api = await apiSignIn(base, admin);
            const { spaces } = await api('/workspace');
            const [doc] = await api(`/spaces/${spaces[0].id}/pages`);
            if (!doc) {
                step('no page in the first Space: skipped the editor chunk');
                return;
            }
            let aborted = 0;
            await page.route('**/assets/RichEditor-*.js', (route) => (aborted++ ? route.continue() : route.abort()));
            tolerated = /net::ERR_FAILED|RichEditor|Failed to fetch dynamically imported module/;
            // The reload guard (once per 30 s) may hold the first part's reload.
            await page.evaluate(() => sessionStorage.removeItem('socio:chunk-reload-at'));
            await goto(`${base}/spaces/${spaces[0].id}/pages/${doc.id}`);
            // Only a new page asks for the chunk again: the reload.
            for (const deadline = Date.now() + 15_000; aborted < 2;) {
                if (Date.now() > deadline) {
                    throw new Error('The editor never asked for its chunk again');
                }
                await page.waitForTimeout(100);
            }
            await page.locator('.ProseMirror').first().waitFor({ timeout: 15_000 });
            await page.unroute('**/assets/RichEditor-*.js');
            tolerated = undefined;
            step('a failed editor chunk reloads the page once, then the editor opens');
            await page.evaluate(() => sessionStorage.removeItem('socio:chunk-reload-at'));
        },
        async people() {
            if (!member.email) {
                step('SKIPPED: deactivation needs Better Auth (this server uses mock auth).');
                return;
            }
            const shot = async (name) => {
                if (!args.shots) {
                    return;
                }
                const { mkdirSync } = await import('node:fs');
                mkdirSync(args.shots, { recursive: true });
                // Past the dialog's opening animation.
                await page.waitForTimeout(400);
                await page.screenshot({ path: `${args.shots}/${name}.png` });
                step(`screenshot ${name}.png`);
            };
            // Bob, signed in in his own browser.
            const bobContext = await guardEgress(await browser.newContext({ viewport: { width: 1100, height: 760 } }));
            const bob = await bobContext.newPage();
            bob.on('pageerror', (error) => errors.push(`pageerror (bob): ${error.message.slice(0, 300)}`));
            const bobSignIn = async () => {
                await bob.getByRole('textbox', { name: 'Email' }).fill(member.email);
                await bob.getByLabel('Password', { exact: true }).fill(member.password);
                await bob.getByRole('button', { name: 'Sign in', exact: true }).click();
            };
            await bob.goto(base);
            await bobSignIn();
            await bob.locator('[data-slot="sidebar-footer"]').getByText(member.name).waitFor({ timeout: 30_000 });
            step(`${member.name} signed in in a second browser`);

            await goto(base);
            await signIn(admin);
            await openSettings('People');
            // The People tab's table (CB-360); its ⋯ menu has the actions.
            const row = page.locator(`[data-slot="people-table"] tr[data-person="${member.email}"]`);
            await row.waitFor({ timeout: 15_000 });
            const first = member.name.split(/\s+/)[0];
            const rowMenu = async (item) => {
                await row.getByRole('button', { name: `Actions for ${member.name}` }).click();
                const items = await page.getByRole('menuitem').allInnerTexts();
                if (item) {
                    await page.getByRole('menuitem', { name: item, exact: true }).click();
                }
                return items;
            };
            await rowMenu('Deactivate…');
            const confirm = page.locator('[data-slot="confirm-deactivate"]');
            await confirm.getByRole('heading', { name: `Deactivate ${member.name}?` }).waitFor({ timeout: 5000 });
            await confirm.locator('[data-slot="deactivation-impact"]').waitFor({ timeout: 10_000 });
            const said = await confirm.innerText();
            if (!/can['’]t sign in any more\. Their chats, pages and files stay/.test(said)) {
                throw new Error(`The preview says: ${said.slice(0, 200)}`);
            }
            await shot('people-deactivate-confirm');
            const accountId = (await (await apiSignIn(base, admin))('/accounts')).accounts.find(
                (entry) => entry.email === member.email,
            )?.id;
            peopleRestore = { accountId };
            const pressed = Date.now();
            await confirm.getByRole('button', { name: `Deactivate ${first}`, exact: true }).click();
            await row.getByText('Deactivated', { exact: true }).waitFor({
                timeout: 10_000,
            });
            const tookMs = Date.now() - pressed;
            const offered = await rowMenu();
            await page.keyboard.press('Escape');
            if (offered.join('|') !== 'Open|Reactivate…') {
                throw new Error(`A deactivated row's menu offers: ${offered.join(', ')}`);
            }
            step(
                `deactivated ${member.name} after the preview (${tookMs} ms to the badge); only Reactivate is offered`,
            );
            await shot('people-deactivated');

            // Bob's open tab loses its session at the next poll.
            await bob.getByRole('textbox', { name: 'Email' }).waitFor({ timeout: 15_000 });
            await bobSignIn();
            await bob
                .getByRole('alert')
                .filter({ hasText: 'This account is deactivated' })
                .waitFor({ timeout: 10_000 });
            step(`${member.name}'s open tab went to sign-in, and his password is refused`);

            await rowMenu('Reactivate…');
            const again = page.locator('[data-slot="confirm-reactivate"]');
            await again.getByRole('button', { name: `Reactivate ${first}`, exact: true }).click();
            await row.getByText('Active', { exact: true }).waitFor({ timeout: 10_000 });
            if (await row.getByText('Deactivated', { exact: true }).count()) {
                throw new Error('The badge stayed after Reactivate');
            }
            peopleRestore = undefined;
            await bobSignIn();
            await bob.locator('[data-slot="sidebar-footer"]').getByText(member.name).waitFor({ timeout: 30_000 });
            step(`reactivated ${member.name}; he signs in again`);
            await bobContext.close();
        },
        async users() {
            // Works on a fresh or a long-lived database: compares sidebar titles
            // instead of assuming empty accounts.
            const titles = threadTitles;
            const aliceTitle = await scenarios.chat({ transcript: false });
            const aliceBefore = await titles();
            await switchUser();
            await signIn(member);
            await page.waitForTimeout(1500);
            const bobBefore = await titles();
            if (bobBefore.includes(aliceTitle)) {
                throw new Error("Bob's sidebar lists alice's conversation");
            }
            if (/embedded[\s\S]*pelican/i.test(await page.locator('[data-slot="sidebar-inset"]').innerText())) {
                throw new Error("Bob's view shows alice's conversation");
            }
            step('bob sees none of alice’s conversations');
            // Create Space follows the server's "create Spaces" permission:
            // members by default (CB-181), admins only when an admin chose so.
            const { permissions } = await (await apiSignIn(base, member))('/workspace');
            const mayCreate = permissions?.createSpaces === true;
            if ((await page.getByLabel('Create Space').count()) > 0 !== mayCreate) {
                throw new Error(`Member ${mayCreate ? "doesn't see" : 'sees'} the Create Space control`);
            }
            step(`bob ${mayCreate ? 'sees' : "doesn't see"} Create Space, as the server's permission says`);
            for (const label of ['Pause all socios', 'Resume all socios']) {
                if (await page.getByLabel(label).count()) {
                    throw new Error(`Member sees the ${label} control`);
                }
            }
            if (await dotMenus().count()) {
                throw new Error('Member sees socio settings controls');
            }
            if (await page.getByText('Edit specialist').count()) {
                throw new Error('Member sees Edit specialist');
            }
            step('bob sees no management controls');
            await openNewChat();
            await page.getByLabel('Start a conversation').fill('Reply with exactly the word: heron');
            await page.getByLabel('Start conversation').click();
            await waitForText(/heron[\s\S]*heron/);
            await page.waitForTimeout(4000); // let the automatic title land
            const bobAfter = await titles();
            const bobNew = bobAfter.filter((title) => !bobBefore.includes(title));
            if (bobAfter.length !== bobBefore.length + 1) {
                throw new Error(`Bob has ${bobAfter.length - bobBefore.length} new conversations, not 1`);
            }
            step('bob chatted');
            await switchUser();
            await signIn(admin);
            await page.waitForTimeout(1500);
            const aliceAfter = await titles();
            if (aliceAfter.length !== aliceBefore.length) {
                throw new Error(`Alice's conversations changed: ${aliceBefore.length} → ${aliceAfter.length}`);
            }
            if (bobNew.some((title) => aliceAfter.includes(title))) {
                throw new Error("Alice's sidebar lists bob's conversation");
            }
            step('alice sees only her own conversations');
        },
    };
    if (!scenarios[scenario]) {
        throw new Error(`Unknown scenario: ${scenario}`);
    }
    await scenarios[scenario]();
    if (args.screenshot) {
        await page.screenshot({ path: args.screenshot });
    }
} catch (error) {
    failed = true;
    step(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
    await browser.close();
    try {
        await cleanUp();
    } catch (error) {
        failed = true;
        step(`FAILED: cleanup: ${error instanceof Error ? error.message : error}`);
    }
}

// The mobile-fit scenario's check, run in the page (CB-96): whether the
// page is wider than the screen, the elements that reach past its right
// edge, and the editable fields under 16 px (iOS zooms in on focus).
function mobileFit() {
    const width = document.documentElement.clientWidth;
    const name = (element) => {
        const slot = element.dataset?.slot ? `[data-slot=${element.dataset.slot}]` : '';
        const classes = [...element.classList].slice(0, 3).map((value) => `.${value}`);
        const label =
            element.getAttribute('aria-label') ??
            element.getAttribute('placeholder') ??
            element.textContent?.trim().slice(0, 30);
        return `${element.tagName.toLowerCase()}${slot}${classes.join('')}${label ? ` "${label}"` : ''}`;
    };
    const style = (element) => getComputedStyle(element);
    // What slides the whole page sideways: the document, or a box that
    // scrolls sideways and holds the page's content (the view canvas,
    // a chat's transcript: CB-107). A box that scrolls on its
    // own inside the page (the board's columns, a table, a code block) is
    // meant to.
    const scrollers = [document.scrollingElement];
    for (const element of document.body.querySelectorAll('*')) {
        if (
            ['auto', 'scroll'].includes(style(element).overflowX) &&
            (element.matches('main, [data-chat-transcript]') || element.querySelector('main, h1'))
        ) {
            scrollers.push(element);
        }
    }
    const overflowing = scrollers.filter((element) => element.scrollWidth > element.clientWidth + 1);
    const scrollWidth = Math.max(width, ...overflowing.map((element) => element.scrollWidth));
    // Elements past the right edge, unless a box that fits clips or
    // scrolls them before the page's scroller does.
    const contained = (element) => {
        for (let box = element.parentElement; box && box !== document.body; box = box.parentElement) {
            if (scrollers.includes(box)) {
                return false;
            }
            const { overflowX, position } = style(box);
            if (position === 'fixed') {
                return true;
            }
            if (overflowX !== 'visible' && box.getBoundingClientRect().right <= width + 1) {
                return true;
            }
        }
        return false;
    };
    const wide = [];
    for (const element of document.body.querySelectorAll('*')) {
        const box = element.getBoundingClientRect();
        if (!box.width && !box.height) {
            continue;
        }
        const css = style(element);
        if (css.visibility === 'hidden' || css.position === 'fixed') {
            continue;
        }
        if (box.right > width + 1 && !contained(element)) {
            wide.push(element);
        }
    }
    // The outermost boxes past the edge, and the innermost (the cause is
    // usually one or the other: a wide table, a long option or word).
    const outermost = wide.filter((element) => !wide.includes(element.parentElement));
    const innermost = wide.filter((element) => !wide.some((other) => other !== element && element.contains(other)));
    const small = [];
    const fields = document.querySelectorAll('input, textarea, select, [contenteditable]');
    for (const field of fields) {
        if (
            field.matches('input') &&
            /^(checkbox|radio|range|file|hidden|button|submit|reset|image|color)$/.test(field.type)
        ) {
            continue;
        }
        // Only the editing host of rich text.
        if (
            field.matches('[contenteditable]') &&
            (!field.isContentEditable || field.parentElement?.isContentEditable)
        ) {
            continue;
        }
        if (field.disabled) {
            continue;
        }
        const box = field.getBoundingClientRect();
        if (box.width < 4 || box.height < 4) {
            continue;
        }
        const css = style(field);
        if (css.visibility === 'hidden') {
            continue;
        }
        const size = parseFloat(css.fontSize);
        if (size < 16) {
            small.push(`${name(field)} ${size}px`);
        }
    }
    return {
        width,
        scrollWidth,
        overflow: overflowing.length > 0,
        wide: [...new Set([...outermost.slice(0, 3), ...innermost.slice(0, 3)])].map(
            (element) => `${name(element)} (to ${Math.round(element.getBoundingClientRect().right)}px)`,
        ),
        small,
    };
}

/** Deletes the conversations this run created; restores Dot settings. */
async function cleanUp() {
    if (!users) {
        return;
    }
    // Before anything signs in as the member.
    if (peopleRestore?.accountId) {
        await (
            await apiSignIn(base, users.admin)
        )(`/accounts/${peopleRestore.accountId}/reactivate`, 'POST', {});
        step('cleanup: reactivated the member');
    }
    const done = await Promise.all(created);
    const callers = {};
    const as = async (user) => (callers[user.id] ??= await apiSignIn(base, user));
    const left = [];
    for (const user of [users.admin, users.member]) {
        const ids = done.filter((entry) => entry.userId === user.id).map((entry) => entry.id);
        if (ids.length) {
            left.push(...(await deleteConversations(await as(user), ids)));
        }
    }
    if (left.length) {
        throw new Error(`could not delete: ${left.join(', ')}`);
    }
    step(`cleanup: deleted ${done.length} conversations`);
    if (notificationsRestore) {
        await notificationsRestore
            .api('/preferences', 'PATCH', {
                notifications: notificationsRestore.notifications,
            })
            .catch(() => {});
        step('cleanup: restored alice’s notification choices');
    }
    if (pushDeviceAdded) {
        await (
            await as(users.admin)
        )(`/notifications/push/subscriptions/${pushDeviceAdded.id}`, 'DELETE').catch(() => {});
        step('cleanup: removed the push device the run added');
    }
    if (byoConnected) {
        await byoConnected('/me/inference/byo-chatgpt', 'DELETE').catch(() => {});
        step('cleanup: disconnected ChatGPT');
    }
    if (byoRestore) {
        await byoRestore.api('/inference/settings', 'PUT', {
            allowedByoKinds: byoRestore.allowed,
        });
        step('cleanup: restored the allowed bring-your-own kinds');
    }
    for (const [owner, id] of createdJobs) {
        await (await as(owner))(`/schedules/jobs/${id}`, 'DELETE').catch(() => {});
        step(`cleanup: deleted job ${id}`);
    }
    if (autoRestore) {
        if (autoRestore.dotId) {
            await autoRestore
                .api('/approvals/policies', 'PUT', {
                    dotId: autoRestore.dotId,
                    capability: 'data.create_dataset',
                    policy: 'manual',
                })
                .catch(() => {});
        }
        await autoRestore.api('/approvals/guidance', 'PUT', { guidance: '' }).catch(() => {});
        step('cleanup: Create datasets back to Manual, guidance cleared');
    }
    for (const [owner, path] of createdFiles) {
        await (await as(owner))(`/data/files?path=${encodeURIComponent(path)}`, 'DELETE').catch(() => {});
        step(`cleanup: deleted file ${path}`);
    }
    for (const [owner, path] of createdFolders) {
        await (
            await as(owner)
        )(`/media/folders?path=${encodeURIComponent(path)}&recursive=1`, 'DELETE').catch(() => {});
        step(`cleanup: deleted folder ${path}`);
    }
    for (const [owner, id] of createdDatasets) {
        await (await as(owner))(`/data/datasets/${id}`, 'DELETE').catch(() => {});
        step(`cleanup: deleted dataset ${id}`);
    }
    for (const [space, id] of createdPages) {
        await (
            await as(users.admin)
        )(`/spaces/${space}/pages/${id}?subpages=true`, 'DELETE');
        step(`cleanup: deleted page ${id}`);
    }
    for (const number of filedIssues) {
        await (
            await as(users.admin)
        )(`/issues/${number}`, 'DELETE');
        step(`cleanup: deleted CB-${number}`);
    }
    // The learning scenario assigns a socio to a container: put it back.
    if (!dotsBefore) {
        return;
    }
    const admin = await as(users.admin);
    const { dots } = await admin('/workspace');
    for (const dot of dotsBefore) {
        const now = dots.find((entry) => entry.id === dot.id);
        if (
            !now ||
            (now.learningContainerId === dot.learningContainerId &&
                now.skillDeliveryEnabled === dot.skillDeliveryEnabled)
        ) {
            continue;
        }
        const { name, instructions, researchAllowed, memoryAllowed } = dot;
        await admin(`/dots/${dot.id}`, 'PUT', {
            name,
            instructions,
            researchAllowed,
            memoryAllowed,
            learningContainerId: dot.learningContainerId ?? null,
            skillDeliveryEnabled: !!dot.skillDeliveryEnabled,
            spaceId: dot.spaceId,
            spaceIds: dot.spaceIds,
        });
        step(`restored the learning settings of socio ${name}`);
    }
}
step(`requests to other origins: ${JSON.stringify([...foreign])}`);
step(`console errors: ${JSON.stringify(errors)}`);
if (failed || foreign.size || errors.length) {
    step('result: FAIL');
    process.exit(1);
}
step('result: PASS');
