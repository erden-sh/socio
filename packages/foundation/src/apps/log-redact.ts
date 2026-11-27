import { ACTOR_ENVELOPE_PATTERN, DATA_TOKEN_PREFIX, SOCIO_TOKEN_PATTERN } from '../actors/redact.js';

// Every pattern here runs on an app's own output, so each takes time in
// proportion to the line (CB-146): a match may start only where a run of
// its characters starts (the lookbehinds), and every repetition that has
// to stop before something else is bounded. A pattern that may start
// anywhere in a run and scan to its end is quadratic on a long line.
// Few passes: a line is read seven times, plus once per known value. The
// Socio token and envelope patterns (packages/foundation/src/actors/redact.ts) start at a fixed
// prefix and stop at their run's end, so they stay linear too.
const RUN = 'A-Za-z0-9_-';
/**
 * Data tokens, JWTs and keys with a known shape (OpenAI-style, Stripe,
 * GitHub, Slack, AWS, Google, GitLab), in one pass.
 */
const TOKENS = new RegExp(
    `(?<![${RUN}])(?:${DATA_TOKEN_PREFIX}[${RUN}]{1,512}|eyJ[${RUN}]{4,4096}\\.[${RUN}]{4,4096}\\.[${RUN}]{0,4096}|sk-[${RUN}]{16,512}|sk_(?:live|test)_[A-Za-z0-9]{8,512}|gh[pousr]_[A-Za-z0-9]{20,512}|github_pat_[A-Za-z0-9_]{20,512}|xox[abposr]-[A-Za-z0-9-]{8,512}|AKIA[0-9A-Z]{16}|AIza[${RUN}]{35}|glpat-[${RUN}]{16,512})`,
    'g',
);
/** `Bearer …` and `Basic …` credentials. */
const AUTHORIZATION =
    /(?<![A-Za-z0-9])(?:(Bearer)[ \t]{1,8}[^\s"',;]{1,4096}|(Basic)[ \t]{1,8}[A-Za-z0-9+/=]{8,4096})/gi;
/** `scheme://user:password@`: the scheme only where a word starts. */
const URL_CREDENTIALS = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]{1,256}:[^\s/@]{1,256}@/gi;
/** The names a credential goes by, as a key: `password`, `apiKey`, `client_secret`, `refresh-token`… */
const CREDENTIAL_KEYS =
    'api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|session[_-]?token|token|client[_-]?secret|secret[_-]?key|secret|password|passwd|passphrase|private[_-]?key';
/**
 * The last word of a camelCase or PascalCase credential key, capitalized:
 * `userPassword`, `githubToken`, `stripeSecretKey`, `awsSecretAccessKey`,
 * `myApiKey`, `UserPassword`. Matched case-sensitively, so only a capital
 * after a letter or digit starts one: words in prose (`tokenize`,
 * `secretary`, `Passwordless`) never do.
 */
const CAMEL_CREDENTIAL_KEYS =
    'Secret(?:Access)?[_-]?[Kk]ey|Secret|Password|Passwd|Passphrase|Token|A(?:pi|PI)[_-]?[Kk]ey|Private[_-]?[Kk]ey';
/**
 * Where a credential key starts: at a word start, in any case, or at a
 * capitalized last word inside a camelCase or PascalCase name. Either way
 * a match starts at a fixed word, so each attempt ends within a few
 * characters unless the key is there.
 */
const keyAt = (keys: string, camelKeys: string) =>
    `(?:(?<![A-Za-z0-9])(?:${keys})|(?-i:(?<=[A-Za-z0-9])(?:${camelKeys})))`;
/**
 * A credential key's quoted value, whole (`"password": "two words"`,
 * `token='a b'`, `secret: "with \"quotes\""`), in JSON, `key=value` and
 * `key: value` forms, with double or single quotes and escapes inside;
 * `authorization` too. A quote not closed on its line is redacted to the
 * line's end. Each alternative stops at its closing quote or the line's
 * end, at most 4,096 characters, so a line costs time in proportion to it.
 */
const QUOTED = new RegExp(
    `(${keyAt(`${CREDENTIAL_KEYS}|authorization`, `${CAMEL_CREDENTIAL_KEYS}|Authorization`)}["']?[ \t]{0,8}[:=][ \t]{0,8})(?:"(?:[^"\\\\\n]|\\\\.){0,4096}"|'(?:[^'\\\\\n]|\\\\.){0,4096}'|(["'])[^\n]{0,4096})`,
    'gi',
);
/** `password=…`, `"apiKey": "…"`, `token: …` and the like, unquoted: to the end of the value's token. */
const ASSIGNED = new RegExp(
    `(${keyAt(CREDENTIAL_KEYS, CAMEL_CREDENTIAL_KEYS)}["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)[^\\s"',;&]{1,4096}`,
    'gi',
);

/** Values shorter than this are never redacted: they would blank words. */
export const MIN_SECRET_LENGTH = 6;
/**
 * How a secret setting's name ends (its last part, split on `_` and `-`):
 * `API_KEY`, `AUTH_TOKEN`, `DB_PASSWORD`, `SENTRY_DSN`, `PASSWORD_SALT`.
 */
const SECRET_ENDINGS = new Set([
    'KEY',
    'APIKEY',
    'TOKEN',
    'SECRET',
    'PASSWORD',
    'PASSWD',
    'PASSPHRASE',
    'PASS',
    'PWD',
    'CREDENTIAL',
    'CREDENTIALS',
    'DSN',
    'SALT',
    'WEBHOOK',
]);
/** `…_KEY` names that are not secrets: `PRIMARY_KEY=userId`. */
const PLAIN_KEYS = new Set([
    'PRIMARY',
    'FOREIGN',
    'SORT',
    'PARTITION',
    'CACHE',
    'IDEMPOTENCY',
    'ROUTING',
    'LOOKUP',
    'GROUP',
    'MAP',
]);
/** Whether a setting's name says it holds a secret. */
function secretName(name: string) {
    const parts = name.toUpperCase().split(/[_-]+/).filter(Boolean);
    const last = parts.at(-1) ?? '';
    if (last === 'URL' && parts.at(-2) === 'WEBHOOK') {
        return true;
    }
    if (!SECRET_ENDINGS.has(last)) {
        return false;
    }
    return !(last === 'KEY' && PLAIN_KEYS.has(parts.at(-2) ?? ''));
}
/** A URL that carries credentials: `user:password@`, or a key in its query. */
const URL_WITH_CREDENTIALS =
    /^[a-z][a-z0-9+.-]{0,30}:\/\/(?:[^\s/@:]+:[^\s/@]+@|[^\s?#]*\?(?:[^\s#]*[&;])?(?:token|access_token|api_key|apikey|key|secret|sig|signature|password|auth)=)/i;

/**
 * Which of an app's settings (the manifest's `env`, the owner's values)
 * are secrets to keep out of its logs: a name ending in KEY, TOKEN,
 * SECRET, PASSWORD, PASS, PWD, CREDENTIAL(S), DSN, SALT or WEBHOOK(_URL)
 * (`PRIVATE_KEY`, `SIGNING_KEY`, `AUTH_TOKEN`; not `AUTH_PROVIDER` or
 * `PRIMARY_KEY`), a description that says it is one, or a URL with
 * credentials or a key in its query.
 * Ordinary settings (`production`, a host, a time zone) stay readable.
 */
export function secretSettings(values: Record<string, unknown>, descriptions: Record<string, string> = {}): string[] {
    return Object.entries(values).flatMap(([name, value]) =>
        typeof value === 'string' &&
        (secretName(name) ||
            /\b(secret|password|token|api key|credential|private key)s?\b/i.test(descriptions[name] ?? '') ||
            URL_WITH_CREDENTIALS.test(value))
            ? [value]
            : [],
    );
}

/**
 * Base64 of a secret inside a longer blob (`user:secret` encoded): at each
 * of the three byte offsets, the characters that depend on the secret's
 * bytes alone.
 */
function base64Inside(bytes: Buffer): string[] {
    const found: string[] = [];
    for (const offset of [0, 1, 2]) {
        const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
        const encoded = padded.toString('base64');
        const from = offset ? 4 : 0;
        const to = Math.floor(padded.length / 3) * 4;
        const middle = encoded.slice(from, to);
        if (middle.length >= 8) {
            found.push(middle, middle.replace(/\+/g, '-').replace(/\//g, '_'));
        }
    }
    return found;
}

/** The forms a secret may take in output, longest first. */
function computeForms(secret: string): string[] {
    const bytes = Buffer.from(secret);
    const hex = bytes.toString('hex');
    return [
        ...new Set(
            [
                secret,
                encodeURIComponent(secret),
                JSON.stringify(secret).slice(1, -1),
                bytes.toString('base64'),
                bytes.toString('base64').replace(/=+$/, ''),
                bytes.toString('base64url'),
                ...base64Inside(bytes),
                hex,
                hex.toUpperCase(),
            ].filter((form) => form.length >= MIN_SECRET_LENGTH),
        ),
    ].sort((a, b) => b.length - a.length);
}

/** Forms of recent secrets, least recently used first out. */
const FORMS = new Map<string, string[]>();
const FORMS_KEPT = 1024;
function formsOf(secret: string): string[] {
    const known = FORMS.get(secret);
    if (known) {
        FORMS.delete(secret);
        FORMS.set(secret, known);
        return known;
    }
    const found = computeForms(secret);
    FORMS.set(secret, found);
    if (FORMS.size > FORMS_KEPT) {
        FORMS.delete(FORMS.keys().next().value!);
    }
    return found;
}

/**
 * Takes credentials out of a mini app's output, one line at a time
 * (CB-146): the values given (the secret settings and data tokens the
 * runtime injected) in every form they may take (as they are,
 * URL-encoded, JSON-escaped, base64, also inside a longer blob, and hex),
 * data tokens, Socio's tokens and actor envelopes, bearer and basic
 * credentials, JWTs, credentials in URLs,
 * keys with a known shape and `key=value` secrets. Values under
 * `MIN_SECRET_LENGTH` are left. Paths and stack traces stay readable: no
 * blanket rule on long strings. Build one per set of values and use it
 * for many lines; each line costs time in proportion to its length.
 */
export class LogRedactor {
    private forms: string[];
    /** The longest form: how much of a cut line may hold part of a value. */
    readonly longest: number;
    constructor(secrets: Iterable<string | null | undefined> = []) {
        const forms = new Set<string>();
        for (const secret of secrets) {
            if (secret && secret.length >= MIN_SECRET_LENGTH) {
                for (const form of formsOf(secret)) {
                    forms.add(form);
                }
            }
        }
        this.forms = [...forms].sort((a, b) => b.length - a.length);
        this.longest = this.forms[0]?.length ?? 0;
    }
    redact(line: string): string {
        let out = line;
        for (const form of this.forms) {
            if (out.includes(form)) {
                out = out.split(form).join('[redacted]');
            }
        }
        return (
            out
                .replace(TOKENS, '[redacted]')
                // Socio's own: `cbsa_`, `cbob_` and the rest, and `x-cb-actor`
                // envelopes, as an app logging its request headers shows them.
                .replace(SOCIO_TOKEN_PATTERN, '[redacted]')
                .replace(ACTOR_ENVELOPE_PATTERN, '[redacted]')
                .replace(AUTHORIZATION, (_match, bearer?: string, basic?: string) => `${bearer ?? basic} [redacted]`)
                .replace(URL_CREDENTIALS, '$1[redacted]@')
                .replace(QUOTED, (match, key: string, open?: string) => {
                    // The value's own quotes stay, so JSON stays JSON; an unclosed one gets none.
                    const quote = open ?? match[key.length];
                    return open ? `${key}${open}[redacted]` : `${key}${quote}[redacted]${quote}`;
                })
                .replace(ASSIGNED, '$1[redacted]')
        );
    }
}

/** One line redacted with these values (`LogRedactor`, for a single use). */
export function redactAppLog(line: string, secrets: Iterable<string | null | undefined> = []): string {
    return new LogRedactor(secrets).redact(line);
}
