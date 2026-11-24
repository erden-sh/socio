import type { ProbeProblem } from './probe';

// What the add-workspace screen says for each probe problem:
// plain words, never the
// server's text. Every redirect problem, a 403 "Unrecognized host." and any
// answer that isn't a sign-in view mean the address doesn't lead to a
// workspace; an address the build refuses means the app can't reach it.

export const NOT_SOCIO = "This address doesn't lead to a Socio workspace.";
export const NOT_AVAILABLE = "This workspace isn't available in the Socio app. Ask your admin.";
export const CANT_CHECK = "Couldn't check this workspace. Try again in a moment.";
export const CANT_REACH = "Couldn't reach this address. Check it and your connection, then try again.";
export const SERVER_OUTDATED =
    "This workspace's server needs an update before the Socio app can use it. Ask your admin.";

const COPY: Record<ProbeProblem, string> = {
    empty: "Enter your workspace's address.",
    unreadable: "That isn't a web address. Check it and try again.",
    scheme: 'Enter a web address, like brain.example.com.',
    userinfo: "Enter your workspace's address, not an email address.",
    insecure: NOT_AVAILABLE,
    port: NOT_AVAILABLE,
    unreachable: CANT_REACH,
    'server-error': CANT_CHECK,
    'unrecognized-host': NOT_SOCIO,
    'not-socio': NOT_SOCIO,
    'redirect-twice': NOT_SOCIO,
    'redirect-path': NOT_SOCIO,
    'redirect-insecure': NOT_SOCIO,
    'redirect-invalid': NOT_SOCIO,
    'server-outdated': SERVER_OUTDATED,
};

/** The line the screen shows for `problem`. */
export function probeCopy(problem: ProbeProblem): string {
    return COPY[problem];
}
