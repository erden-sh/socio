import type { Character } from '../art.ts';
import { ORIGIN, PAGES, PUBLISHER } from '../facts.ts';
import { icon } from '../icons.ts';
import type { Assets } from '../layout.ts';
import { m, page, sq } from '../layout.ts';
import { browserApp, phoneApproval, phoneBoard, phoneHome, phoneRoom } from '../mocks.ts';

// The home page: the hero with the drawn app, the six module tiles in their tones, the phone
// strip, the eight socios, privacy, the two ways to run it, Erden, and the closing band.

/** The cast: id, name, species, tone and the card's line (the owner confirmed all eight). */
export const CAST: [Character, string, string, string, string][] = [
    [
        'sebas',
        'Sebas',
        'Stone crab',
        'orange',
        'Confident and busy. Clacks his claws when he types and pumps one when he’s done.',
    ],
    ['manny', 'Manny', 'Manatee', 'sky', 'Slow, patient and thorough, with a cafecito always in reach.'],
    ['mingo', 'Mingo', 'Flamingo', 'rose', 'Poised and a little vain. Taps her foot when she’s kept waiting.'],
    ['rulo', 'Rulo', 'Curly-tailed lizard', 'emerald', 'Never still. Does push-ups to show off when a job lands.'],
    ['lino', 'Lino', 'Rooster', 'amber', 'Up first, every morning. Your daily digest, on time.'],
    ['flake', 'Flake', 'Dolphin', 'indigo', 'Quick and friendly. Happiest deep in a long thread.'],
    ['iggy', 'Iggy', 'Iguana', 'emerald', 'Sunbathes on the backlog until it’s clear.'],
    ['rosy', 'Rosy', 'Roseate spoonbill', 'violet', 'Sorts, sifts and files. Nothing slips past her.'],
];
const TILES: [string, string, string, string, string[]][] = [
    [
        'mint',
        'message-circle',
        'Chats and rooms',
        'Talk to a socio one on one, or bring people and socios into a room and hand work between them.',
        ['@mentions', 'Handoffs', 'Voice'],
    ],
    [
        'sky',
        'folder',
        'Spaces and pages',
        'Your handbook, client notes and plans, written together. Socios read them before they answer.',
        ['Docs', 'Shared spaces'],
    ],
    [
        'orange',
        'list-todo',
        'The board',
        'Bugs, requests and to-dos in one place. Anyone can file, vote and comment, socios too.',
        ['Votes', 'Triage'],
    ],
    [
        'amber',
        'shield-check',
        'Approvals',
        'Socios ask before they send, pay or publish. You approve from your phone in a tap.',
        ['Push', 'Audit trail'],
    ],
    [
        'violet',
        'book-open',
        'Memories and schedules',
        'Socios remember what matters to your team and run the tasks you set: daily, weekly, whenever.',
        ['Recurring', 'Digests'],
    ],
    [
        'indigo',
        'bot',
        'Your socios',
        'Give each one a name, a character and a job. They work in the open, where your team can see.',
        ['8 characters', 'Your model'],
    ],
];

/** Structured data for search: the publisher and the app. A data block, not a script, so the CSP allows it. */
export function jsonLd(): string {
    const data = [
        {
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: PUBLISHER,
            url: ORIGIN,
            logo: `${ORIGIN}/apple-touch-icon.png`,
        },
        {
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'Socio',
            url: ORIGIN,
            description: PAGES.home.desc,
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web, iOS, Android',
            publisher: { '@type': 'Organization', name: PUBLISHER },
        },
    ];
    return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>\n`;
}

export const home = (assets: Assets) =>
    page({
        key: 'home',
        active: 'product',
        assets,
        headExtra: jsonLd(),
        body: `<section class="hero"><div class="container hero-grid">
  <div>
    <span class="pill t-indigo"><span class="dot">${icon('sparkles')}</span>Now on iPhone and Android, early access</span>
    <h1>Your team’s workspace, <span class="grad">with AI&nbsp;socios.</span></h1>
    <p class="lede">Chat, rooms, pages, a board and approvals in one place. Socios do the busywork and ask before anything that matters. On the web and on your phone.</p>
    <div class="ctas"><a class="btn btn-primary btn-lg" href="/hosted#waitlist">Join the hosted waitlist ${icon('arrow-right')}</a><a class="btn btn-outline btn-lg" href="/self-host">${icon('terminal')}Run it yourself</a></div>
    <div class="fine"><span>${icon('check')}No ads, ever</span><span>${icon('check')}Encrypted on your phone</span><span>${icon('check')}Your servers or ours</span></div>
  </div>
  <div class="hero-visual" role="img" aria-label="Socio on the web and on a phone: a room where Sebas drafts a launch email, hands the list to Manny, and asks for approval before sending">${browserApp()}${phoneHome()}<img class="float-sebas" src="/art/rulo.svg" alt=""></div>
</div></section>

<section id="features"><div class="container">
  <div class="section-head t-mint"><div class="kicker">One workspace</div><h2>Everything your team does, in one calm place</h2><p>Each part of Socio has its own color, in the app and here, so you always know where you are.</p></div>
  <div class="tiles">${TILES.map(([t, ic, h, p, tags]) => `<div class="tile t-${t}">${sq(t, ic)}<h3>${h}</h3><p>${p}</p><div class="peek">${tags.map((x) => `<span>${x}</span>`).join('')}</div></div>`).join('')}</div>
</div></section>

<section class="phones-band"><div class="container">
  <div class="section-head t-sky"><div class="kicker">On your phone</div><h2>The whole team in your pocket</h2><p>A native app for iPhone and Android: rooms, the board and approvals, with notifications encrypted for your phone.</p></div>
  <div class="phones">
    <figure aria-hidden="true">${phoneHome()}<figcaption>${sq('mint', 'house', 'sm')}Home</figcaption></figure>
    <figure aria-hidden="true">${phoneRoom()}<figcaption>${sq('mint', 'messages-square', 'sm')}A room</figcaption></figure>
    <figure aria-hidden="true">${phoneApproval()}<figcaption>${sq('amber', 'shield-check', 'sm')}An approval</figcaption></figure>
    <figure aria-hidden="true">${phoneBoard()}<figcaption>${sq('orange', 'list-todo', 'sm')}The board</figcaption></figure>
  </div>
</div></section>

<section><div class="container">
  <div class="section-head t-orange"><div class="kicker">Meet the socios</div><h2>Eight characters, one for every job</h2><p>Pick who answers. Each socio has a face, a mood and a way of telling you it’s working, waiting or done.</p></div>
  <div class="cast">${CAST.map(([id, n, s, t, p]) => `<div class="cast-card t-${t}">${m(id, `${n}, the ${s.toLowerCase()}`)}<div class="species">${s}</div><h3>${n}</h3><p>${p}</p></div>`).join('')}</div>
</div></section>

<section><div class="container">
  <div class="section-head t-emerald"><div class="kicker">Private by design</div><h2>Your work stays your work</h2></div>
  <div class="privacy-grid">
    <div class="item">${sq('emerald', 'eye-off')}<h4>No ads, no selling</h4><p>We don’t sell data or show ads. The app’s analytics only help us fix and improve Socio.</p></div>
    <div class="item">${sq('sky', 'lock')}<h4>Encrypted on your phone</h4><p>The app’s copy is encrypted and left out of backups. Notifications are sealed for your device.</p></div>
    <div class="item">${sq('indigo', 'server')}<h4>Your servers or ours</h4><p>Run Socio on your own machines, or let us host a private workspace of your own.</p></div>
    <div class="item">${sq('amber', 'hand')}<h4>Socios ask first</h4><p>Anything that sends, pays or publishes waits for a person to approve it.</p></div>
  </div>
</div></section>

<section class="tw:pt-0"><div class="container">
  <div class="section-head t-indigo"><div class="kicker">Two ways to run it</div><h2>Host it yourself, or let us</h2></div>
  <div class="split">
    <div class="card t-indigo">${sq('indigo', 'terminal')}<h3>Run it yourself</h3><p>Free for your own team under the Sustainable Use License. Bring your own servers and your own AI model.</p>
      <ul class="checks"><li>${icon('check')}One Docker stack, backups built in</li><li>${icon('check')}Any OpenAI-compatible model</li><li>${icon('check')}Workspace data stored on your own servers; AI requests go only to the model provider you choose</li></ul>
      <div class="actions"><a class="btn btn-outline" href="/self-host">Code coming soon ${icon('arrow-right')}</a></div></div>
    <div class="card t-mint">${sq('mint', 'heart-handshake')}<h3>Hosted by us</h3><p>For small businesses that want Socio without running servers. We handle updates, backups and support.</p>
      <ul class="checks"><li>${icon('check')}A private workspace, set up for you</li><li>${icon('check')}Daily backups and updates</li><li>${icon('check')}A person to talk to</li></ul>
      <div class="actions"><a class="btn btn-primary" href="/hosted#waitlist">Early access: join the waitlist ${icon('arrow-right')}</a></div></div>
  </div>
</div></section>

<section class="tw:pt-0"><div class="container">
  <div class="erden"><span class="mark">Erden</span><p><strong>Socio uses Erden to ground agents;</strong> deep integrations are in the works.</p><a class="btn btn-outline" href="https://erden.sh">erden.sh ${icon('arrow-up-right')}</a></div>
</div></section>

<section class="tw:pt-0"><div class="container">
  <div class="cta-band"><div><h2>Bring your team and a few socios.</h2><p>Hosted Socio is in early access. Tell us about your team and we’ll be in touch.</p><div class="ctas tw:flex tw:gap-[.6rem] tw:mt-[1.6rem] tw:flex-wrap"><a class="btn btn-primary btn-lg" href="/hosted#waitlist">Join the waitlist</a><a class="btn btn-outline btn-lg" href="/support">Talk to us</a></div></div>
  <div class="crew">${(['manny', 'sebas', 'mingo', 'rosy'] as const).map((id) => m(id)).join('')}</div></div>
</div></section>`,
    });
