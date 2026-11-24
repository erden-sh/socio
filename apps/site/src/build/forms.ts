import { icon } from './icons.ts';

// The site's three forms: the hosted waitlist, notify-me on /self-host, and the support form.
// All post to one endpoint with a `kind`, and work without JavaScript. Each has a honeypot field
// people never see. The endpoint is the Worker's (wrangler.toml, run_worker_first); until the
// handler lands (Turnstile, D1, the rate limit, the email notice) it answers that forms open soon
// and keeps nothing. The handler adds the Turnstile widget where `turnstileSlot` sits.

export const FORM_ACTION = '/forms';
export const FORM_KINDS = ['waitlist', 'notify', 'support'] as const;
export type FormKind = (typeof FORM_KINDS)[number];
/** The honeypot's name: a person never sees or fills it; a bot that fills it is dropped (once the handler lands). */
export const HONEYPOT = 'website';

export const formOpen = (kind: FormKind, cls = '') =>
    `<form class="${cls}" method="post" action="${FORM_ACTION}">
  <input type="hidden" name="kind" value="${kind}">
  <div class="hp" aria-hidden="true"><label>Leave this empty <input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>`;

/** Where the form handler puts the Turnstile widget; empty until then. */
export const turnstileSlot = () => `<div class="turnstile-slot" data-turnstile></div>`;

/** A required checkbox, styled as the mockups' box. */
export const consentCheck = (name: string, text: string) =>
    `<label class="check"><input class="box-input" type="checkbox" name="${name}" value="yes" required><span class="box">${icon('check')}</span><span>${text}</span></label>`;
