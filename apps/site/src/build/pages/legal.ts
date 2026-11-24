import {
    ERASURE_DAYS,
    FORM_RETENTION_MONTHS,
    GOVERNING_LAW,
    LEGAL_UPDATED,
    PHONE_ERASE_DAYS,
    PHONE_LOCK_DAYS,
    PRIVACY_EMAIL,
    PUBLISHER,
    RELAY_EXPIRE_DAYS,
    SESSION_COOKIE,
    SESSION_DAYS,
    SUPPORT_EMAIL,
} from '../facts.ts';
import { icon } from '../icons.ts';
import type { Assets } from '../layout.ts';
import { page, sq } from '../layout.ts';

// The legal pages: privacy, terms and cookies. No draft
// banner; each ends with an "updated from time to time" clause. Service providers are named by
// role, never by cloud. The facts the code decides (the session cookie, the relay's expiry, the
// phone's lease) come from facts.ts, which tests/facts.test.ts holds to the code.

type LegalKey = 'privacy' | 'terms' | 'cookies';
const OTHERS: [string, string][] = [
    ['privacy', 'Privacy Policy'],
    ['terms', 'Terms of Service'],
    ['cookies', 'Cookie Policy'],
    ['delete-account', 'Delete your account'],
];

type Section = [id: string, title: string, html: string];
type Summary = [tone: string, icon: string, title: string, text: string];
interface Legal {
    crumbs: string;
    h1: string;
    intro: string;
    sections: Section[];
    summary: Summary[];
    tone?: string;
}

function legal(key: LegalKey, assets: Assets, { crumbs, h1, intro, sections, summary, tone = 'mint' }: Legal) {
    const toc = sections
        .map(([id, t], i) => `<li><a href="#${id}"${i === 0 ? ' class="on"' : ''}>${i + 1}. ${t}</a></li>`)
        .join('');
    const body = sections.map(([id, t, html], i) => `<h2 id="${id}">${i + 1}. ${t}</h2>${html}`).join('\n');
    const others = OTHERS.filter(([k]) => k !== key);
    return page({
        key,
        active: 'legal',
        assets,
        body: `<div class="legal-hero t-${tone}"><div class="container">
  <div class="crumbs">Legal ${icon('chevron-right')} ${crumbs}</div>
  <h1>${h1}</h1>
  <div class="meta"><span>Last updated ${LEGAL_UPDATED}</span><span>${PUBLISHER}</span><span>${icon('clock')} ${Math.max(4, Math.round(body.length / 1600))} min read</span></div>
  ${summary ? `<div class="summary">${summary.map(([t, ic, b, s]) => `<div>${sq(t, ic, 'sm')}<p><b>${b}</b><span>${s}</span></p></div>`).join('')}</div>` : ''}
</div></div>
<div class="legal-wrap"><div class="container legal-layout">
  <aside class="toc"><h5>On this page</h5><ol>${toc}</ol><div class="other"><h5 class="tw:mt-0">Also</h5>${others.map(([k, t]) => `<a href="/${k}">${t}</a>`).join('')}</div></aside>
  <article class="prose">${intro}\n${body}</article>
</div></div>`,
    });
}

export const privacy = (assets: Assets) =>
    legal('privacy', assets, {
        crumbs: 'Privacy Policy',
        h1: 'Privacy Policy',
        summary: [
            ['emerald', 'eye-off', 'No ads, no selling', 'We never sell your data or use it for advertising.'],
            ['sky', 'building-2', 'Your workspace, your rules', 'Your workspace’s admin controls its data.'],
            ['amber', 'cookie', 'Analytics with consent', 'The site counts visits only if you agree.'],
        ],
        intro: `<p>This policy explains what information Ingenio Ventures Inc. (“Ingenio”, “we”) collects when you use socio.sh, the Socio apps for iPhone and Android, and the Socio workspaces we host, how we use it, and the choices you have.</p>`,
        sections: [
            [
                'who',
                'Who we are',
                `<p>Socio is published by Ingenio Ventures Inc. Each Socio workspace is run by an <b>operator</b>, usually your employer. The operator controls the workspace’s data and decides who can join. When we host a workspace for a customer, we process its data on the customer’s behalf. When a company runs Socio on its own servers, its workspace’s data is stored on those servers, not ours. We receive only what its apps send us to work: notification registrations for the push relay, and app analytics if you consent.</p>`,
            ],
            [
                'collect',
                'Information we collect',
                `<h3>What the app sends to your workspace</h3><ul><li>Your email address and sign-in details</li><li>What you write and share: messages, pages, board items, memories, schedules, approvals, photos (with location data removed) and files</li><li>Search queries, and which screen you’re on, so teammates can see you’re active</li><li>A device name and install ID, and the IP address the server sees</li></ul><h3>Notifications</h3><p>To deliver notifications we keep your device’s push token, its platform and app ID, and a hashed secret. We never see the text of a notification: your workspace encrypts it for your phone before it reaches us.</p><h3>This website</h3><ul><li>What you type into a form: your name, email, company, team size and message</li><li>With your consent, analytics about your visit (see <a href="#cookies">Cookies and analytics</a>)</li></ul><h3>App analytics</h3><p>With your consent, the apps send usage events, such as which screens are opened and when something fails, so we can fix and improve Socio. They never include what you write.</p>`,
            ],
            [
                'use',
                'How we use your information',
                `<ul><li>To run Socio: sign you in, sync your workspace and deliver notifications</li><li>To answer you when you write to us or join a waitlist</li><li>To understand how the site and apps are used, and to fix and improve them</li><li>To keep Socio secure and prevent spam and abuse</li></ul><p>We don’t use your information for advertising, and we don’t build profiles to sell to anyone.</p>`,
            ],
            [
                'workspace',
                'Who sees what in a workspace',
                `<p>Your own chats with a socio, your tasks and your memories aren’t shared with your teammates. Like everything in the workspace, they belong to the company that runs it: when your account is closed, an admin hands them to someone else. Spaces, pages, rooms and the board are shared with the people they’re shared with. Workspace admins manage accounts and can see what’s needed to run the workspace.</p>`,
            ],
            [
                'ai',
                'Messages and AI socios',
                `<p>When you talk to a socio, your message and the context it needs are sent to the AI model provider your workspace uses, only to produce an answer. Socios act through approvals for anything that sends, pays or publishes, so a person decides.</p>`,
            ],
            [
                'sharing',
                'Sharing with others',
                `<p>We don’t sell your personal information. We share it only:</p><ul><li>With service providers that help us run Socio: hosting, content delivery and security, analytics, email delivery, Apple and Google for push notifications, and AI model providers. They work under contracts that limit what they may do with it.</li><li>When the law requires it, or to protect the safety of our users.</li><li>If Ingenio is involved in a merger or acquisition, under this policy.</li></ul>`,
            ],
            [
                'security',
                'Security',
                `<ul><li>Everything travels over encrypted connections.</li><li>The copy of your workspace on your phone is encrypted and left out of device backups.</li><li>Files and credentials on the server are sealed with the workspace’s own data key.</li></ul><p>No system is perfectly secure. Please keep your devices locked and your email account safe.</p>`,
            ],
            [
                'rights',
                'Your rights',
                `<p>You can ask to access, correct, export or delete your information, and to object to non-essential uses. For a workspace your company runs, ask its admin. For a workspace we host, the company that runs it decides what happens to its content, and we act on its instructions. For data Ingenio holds itself (this website’s forms and analytics, notification registrations and app analytics), write to <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>. See <a href="/delete-account">Delete your account</a> for how accounts are removed.</p>`,
            ],
            [
                'retention',
                'Retention',
                `<ul><li>Accounts are deactivated first, so the team’s work stays intact. When an account is removed permanently, at its owner’s or the workspace’s request, its sign-in data, devices, sessions and notification registrations are deleted within ${ERASURE_DAYS} days; its content stays with the workspace, handed to someone else.</li><li>Notification registrations are dropped ${RELAY_EXPIRE_DAYS} days after a device last checks in.</li><li>The phone’s copy is erased when you sign out. If the app can’t reach the workspace for ${PHONE_LOCK_DAYS} days it locks, and ${PHONE_ERASE_DAYS} days later it erases itself.</li><li>Waitlist and contact form entries are deleted ${FORM_RETENTION_MONTHS} months after our last contact, or sooner if you ask.</li><li>Hosted workspaces are backed up daily; backups roll off on a fixed schedule.</li></ul>`,
            ],
            [
                'cookies',
                'Cookies and analytics',
                `<p>socio.sh uses analytics cookies only if you accept them in the cookie banner. If you don’t, we only count page views, with no cookie and nothing that identifies you. We use PostHog, served through our own domain. The web app uses a session cookie to keep you signed in. The full list is in our <a href="/cookies">Cookie Policy</a>.</p>`,
            ],
            [
                'children',
                'Children',
                `<p>Socio is a work tool for adults. It isn’t meant for anyone under 18, and we don’t knowingly collect information from children.</p>`,
            ],
            [
                'changes',
                'Changes to this policy',
                `<div class="callout t-sky">${icon('info')}<span>We may update this policy from time to time. When we do, we change the “Last updated” date above, and if a change is significant we tell you in the app or by email before it takes effect.</span></div>`,
            ],
            [
                'contact',
                'Contact',
                `<p>${PUBLISHER}<br>Privacy questions: <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a><br>Everything else: <a href="/support">Support</a></p>`,
            ],
        ],
    });

export const terms = (assets: Assets) =>
    legal('terms', assets, {
        crumbs: 'Terms of Service',
        h1: 'Terms of Service',
        tone: 'indigo',
        summary: [
            ['mint', 'user-round-check', 'Your content is yours', 'You own what you and your team create.'],
            ['amber', 'shield-check', 'Review what AI writes', 'Socios can be wrong; approvals keep you in charge.'],
            ['indigo', 'scale', 'Self-hosting is separate', 'Running Socio yourself follows its license.'],
        ],
        intro: `<p>These terms are an agreement between you and Ingenio Ventures Inc. (“Ingenio”, “we”) for the Socio workspaces we host and the Socio apps. Please read them carefully.</p>`,
        sections: [
            [
                'accept',
                'Accepting these terms',
                `<p>By creating an account or using Socio you confirm that you are at least 18 and agree to these terms. If you use Socio for a company, you agree on its behalf and confirm you’re allowed to.</p>`,
            ],
            [
                'service',
                'Using Socio',
                `<p>With Socio your team can chat with each other and with AI socios, share spaces and pages, track work on a board, approve socio actions and set recurring tasks, on the web and on your phone.</p>`,
            ],
            [
                'content',
                'Your content and AI output',
                `<ul><li>You and your team own the content you put into Socio. You give us permission to store and process it only to run the service for you.</li><li>Socios use AI models, and AI can be wrong, incomplete or out of date. Review what a socio produces before you rely on it.</li><li>Approvals exist so a person decides before a socio sends, pays or publishes anything. You’re responsible for what you approve.</li></ul>`,
            ],
            [
                'conduct',
                'Acceptable use',
                `<p>Don’t use Socio to break the law, harass people, send spam, infringe others’ rights, spread malware, or try to get around its security or limits. Don’t use socios to do any of these things on your behalf.</p>`,
            ],
            [
                'plans',
                'Early access and prices',
                `<p>Hosted Socio is in early access. We don’t charge anything until we agree a price with you, and we give at least 30 days’ notice before any price change.</p>`,
            ],
            [
                'suspend',
                'Suspension and appeals',
                `<p>We may suspend accounts or workspaces that break these terms or put others at risk. Where we can, we warn first. You can appeal through <a href="/support">Support</a>.</p>`,
            ],
            [
                'license',
                'Self-hosted Socio',
                `<p>These terms cover Ingenio’s hosted service and the apps. If you run Socio on your own servers, the Sustainable Use License that comes with the code governs that use instead.</p>`,
            ],
            [
                'liability',
                'Limitation of liability',
                `<p>Socio is provided “as is”. To the extent the law allows, Ingenio isn’t liable for indirect or consequential losses, or for decisions made on the basis of AI output, and our total liability is limited to what you paid us in the 12 months before the claim.</p>`,
            ],
            [
                'end',
                'Ending your use',
                `<p>You can stop using Socio at any time. Workspace admins can export their workspace’s data before closing it.</p>`,
            ],
            [
                'changes',
                'Changes to these terms',
                `<div class="callout t-sky">${icon('info')}<span>We may update these terms from time to time. We’ll change the “Last updated” date, and tell you in advance in the app or by email when a change is significant. If you keep using Socio after a change takes effect, you accept the updated terms.</span></div>`,
            ],
            [
                'contact',
                'Governing law and contact',
                `<p>These terms are governed by the laws of ${GOVERNING_LAW}.<br>Questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>`,
            ],
        ],
    });

export const cookies = (assets: Assets) =>
    legal('cookies', assets, {
        crumbs: 'Cookie Policy',
        h1: 'Cookie Policy',
        tone: 'amber',
        summary: [
            ['amber', 'cookie', 'You choose', 'Analytics run only after you accept.'],
            ['emerald', 'eye-off', 'No ad cookies', 'No advertising or cross-site tracking.'],
            ['sky', 'settings-2', 'Change any time', 'Use Cookie settings in the footer.'],
        ],
        intro: `<p>This policy explains the cookies and similar storage that socio.sh and the Socio apps use, what each is for, and how to change your choice.</p><p><button class="btn btn-primary" type="button" data-open-cookie-settings>${icon('settings-2')}Open cookie settings</button></p>`,
        sections: [
            [
                'what',
                'What cookies are',
                `<p>Cookies are small text files a website stores on your device so it can remember something between visits, like that you’re signed in. “Local storage” does a similar job inside your browser. We list both below.</p>`,
            ],
            [
                'kinds',
                'The kinds we use',
                `<h3>Strictly necessary</h3><p>Needed for the site and app to work, such as remembering your cookie choice or keeping you signed in. They can’t be turned off.</p><h3>Product analytics (optional)</h3><p>Help us see which pages and features are useful and where things go wrong. We use PostHog, sent through our own domain. These cookies are set only if you accept them; if you reject them, we count page views alone, with no cookie and nothing that identifies you.</p>`,
            ],
            [
                'list',
                'The full list',
                `<h3>socio.sh</h3><table><tr><th>Name</th><th>Kind</th><th>What it does</th><th>Lasts</th></tr>
<tr><td><code>socio_consent</code></td><td>Necessary</td><td>Remembers your cookie choice (local storage)</td><td>12 months</td></tr>
<tr><td><code>ph_&lt;project&gt;_posthog</code></td><td>Analytics</td><td>Counts visits and page views; set only after you accept. If you reject, page views are counted with no cookie and no identifier</td><td>12 months</td></tr>
<tr><td>Turnstile</td><td>Necessary</td><td>Checks that a form was sent by a person, not a bot; loaded only on pages with a form</td><td>Session</td></tr></table>
<h3>The Socio web app and mobile apps</h3><table><tr><th>Name</th><th>Kind</th><th>What it does</th><th>Lasts</th></tr>
<tr><td><code>${SESSION_COOKIE}</code></td><td>Necessary</td><td>Keeps you signed in to your workspace (HttpOnly, Secure, SameSite=Strict)</td><td>${SESSION_DAYS} days</td></tr>
<tr><td>Theme preference</td><td>Functional</td><td>Remembers light or dark (local storage)</td><td>Until cleared</td></tr>
<tr><td>PostHog</td><td>Analytics</td><td>Usage events in the apps, never what you write; only with your consent</td><td>12 months</td></tr></table>`,
            ],
            [
                'nope',
                'What we don’t use',
                `<p>No advertising cookies, no retargeting, no cross-site tracking, and no selling of data.</p>`,
            ],
            [
                'manage',
                'Changing your choice',
                `<p>Choose <b>Cookie settings</b> at the bottom of any page to accept or reject analytics again. You can also clear cookies in your browser:</p><ul><li><b>Chrome:</b> Settings › Privacy and security › Third-party cookies</li><li><b>Safari:</b> Settings › Privacy › Manage Website Data</li><li><b>Firefox:</b> Settings › Privacy &amp; Security › Cookies and Site Data</li><li><b>Edge:</b> Settings › Cookies and site permissions</li></ul>`,
            ],
            [
                'changes',
                'Changes to this policy',
                `<div class="callout t-sky">${icon('info')}<span>We may update this policy from time to time, for example when we add or remove a cookie. The “Last updated” date above shows when it last changed.</span></div><p>Questions: <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a></p>`,
            ],
        ],
    });
