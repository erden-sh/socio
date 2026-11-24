#!/usr/bin/env node
// Board parity on live data (the checks "Board filters match the web on live
// data" and "Board sorts match the web"): reads a workspace's
// board once, read-only, then lays it out as the app and as the web do over
// every case of the matrix and compares them (board-parity-cases.ts says how
// each side gets there).
//
//   SMOKE_BASE_URL=… SMOKE_LOGIN=… SMOKE_PASSWORD=… \
//     node apps/mobile/e2e/board-parity.mjs --out <dir>
//   node apps/mobile/e2e/board-parity.mjs --capture <dir>/capture.json --out <dir>
//
// Online, it signs in once (the sign-in is rate limited), asks `GET /api/issues`
// and `GET /api/issues/search?q=` for each of PARITY_QUERIES, and signs out,
// whatever happened between. It writes nothing to the workspace. Every request
// carries a generic User-Agent and nothing about the person but the account's
// own sign-in; the login and password are read from the environment and go
// only into the sign-in's body, never into output, a file or an error.
// `--capture` runs the cases again on a capture already taken, with no request.
//
// It prints counts and pass or fail per group only. The capture (the raw
// bodies) and the report (each case's differences, by issue number, with the
// titles of the issues they name) go into --out, which must stay out of the
// repository and out of PRs (the workspace's internal titles): .local/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const SHARED_SRC = join(import.meta.dirname, '../../../packages/shared/src');

/** The User-Agent of every request: says nothing about the person or the machine. */
export const USER_AGENT = 'research-script/0.1';

const USAGE = `Usage: node apps/mobile/e2e/board-parity.mjs --out <dir> [--capture <file>]

  --out <dir>        where capture.json and report.json go (keep it in .local/)
  --capture <file>   run on a capture already taken, with no request

Online, it reads SMOKE_BASE_URL, SMOKE_LOGIN and SMOKE_PASSWORD from the environment.`;

/** @param {string[]} argv */
export function parseParityArgs(argv) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: { out: { type: 'string' }, capture: { type: 'string' }, help: { type: 'boolean' } },
    });
    if (values.help) {
        return { help: true };
    }
    if (!values.out) {
        throw new Error(`--out is required.\n\n${USAGE}`);
    }
    return { help: false, out: values.out, capture: values.capture ?? null };
}

/**
 * The workspace's origin, login and password from the environment; the error
 * names the variables, never their values.
 * @param {Record<string, string | undefined>} env
 */
export function liveAccount(env) {
    const missing = ['SMOKE_BASE_URL', 'SMOKE_LOGIN', 'SMOKE_PASSWORD'].filter((name) => !env[name]);
    if (missing.length > 0) {
        throw new Error(`Set ${missing.join(', ')} (or pass --capture).`);
    }
    const origin = new URL(/** @type {string} */ (env.SMOKE_BASE_URL)).origin;
    if (!origin.startsWith('https://')) {
        throw new Error('SMOKE_BASE_URL must be https.');
    }
    return {
        origin,
        login: /** @type {string} */ (env.SMOKE_LOGIN),
        password: /** @type {string} */ (env.SMOKE_PASSWORD),
    };
}

/**
 * Takes one capture: signs in, reads the list and each query's matches, signs
 * out (also after a failure, once signed in). Errors say the request and its
 * status only, never a body (a sign-in's could echo the login).
 * @param {{ origin: string, login: string, password: string }} account
 * @param {readonly string[]} queries
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ issues: string, searches: Record<string, string> }>}
 */
export async function takeCapture(account, queries, fetchImpl = fetch) {
    let cookie = '';
    /** @param {string} method @param {string} path @param {unknown} [body] */
    const call = async (method, path, body) => {
        const response = await fetchImpl(account.origin + path, {
            method,
            redirect: 'manual',
            headers: {
                'User-Agent': USER_AGENT,
                Origin: account.origin,
                Accept: 'application/json',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(cookie ? { Cookie: cookie } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`${method} ${path.split('?')[0]} answered ${response.status}.`);
        }
        return response;
    };
    const signIn = await call('POST', '/api/auth/sign-in/email', { email: account.login, password: account.password });
    await signIn.body?.cancel();
    cookie = signIn.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0])
        .join('; ');
    try {
        const issues = await (await call('GET', '/api/issues')).text();
        /** @type {Record<string, string>} */
        const searches = {};
        for (const query of queries) {
            searches[query] = await (
                await call('GET', `/api/issues/search?${new URLSearchParams({ q: query })}`)
            ).text();
        }
        return { issues, searches };
    } finally {
        // Best effort: a failed sign-out leaves a session that expires by itself; say so without its body.
        await call('POST', '/api/auth/logout', {}).then(
            (response) => response.body?.cancel(),
            (/** @type {Error} */ error) => console.error(`Signing out failed: ${error.message}`),
        );
    }
}

/**
 * The report for .local/: each failing case's differences, then the titles of
 * the issues they name, so the owner can read them; the summary first.
 * @param {ReturnType<import('./board-parity-cases.ts').paritySummary>} summary
 * @param {import('./board-parity-cases.ts').ParityResult[]} results
 * @param {readonly { number: number, title: string }[]} issues
 */
export function parityReport(summary, results, issues) {
    const failed = results.filter((result) => !result.pass);
    const named = new Set(failed.flatMap((result) => result.differences.join(' ').match(/\d+/g) ?? []).map(Number));
    return {
        summary,
        failed,
        titles: Object.fromEntries(
            issues.filter((issue) => named.has(issue.number)).map((issue) => [issue.number, issue.title]),
        ),
        cases: results.map(({ group, name, pass, rows }) => ({ group, name, pass, rows })),
    };
}

/** @param {ReturnType<import('./board-parity-cases.ts').paritySummary>} summary */
export function summaryLines(summary) {
    return [
        ...Object.entries(summary.groups).map(
            ([group, { cases, passed, rows }]) =>
                `${group.padEnd(9)} ${String(passed).padStart(4)}/${String(cases).padEnd(4)} passed, ${rows} rows compared`,
        ),
        `${summary.pass ? 'PASS' : 'FAIL'}: ${summary.passed} of ${summary.cases} cases`,
    ];
}

async function main() {
    const args = parseParityArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        return;
    }
    // The cases run the app's TypeScript (src/sync, src/shell) under Node, with
    // @socio/shared from its source, as metro.config.js and vitest.config.mts
    // give it (shared's exports point at dist/, which only a build makes).
    registerHooks({
        resolve(specifier, context, next) {
            const shared = /^@socio\/shared\/(.*)$/.exec(specifier);
            return shared
                ? { url: pathToFileURL(join(SHARED_SRC, `${shared[1]}.ts`)).href, shortCircuit: true }
                : next(specifier, context);
        },
    });
    // tsx for the app's extensionless imports, ESM and CommonJS alike.
    const tsconfig = join(import.meta.dirname, '../tsconfig.json');
    (await import('tsx/cjs/api')).register({ tsconfig });
    (await import('tsx/esm/api')).register({ tsconfig });
    const cases = await import('./board-parity-cases.ts');
    const out = resolve(args.out);
    mkdirSync(out, { recursive: true });
    const capture = args.capture
        ? JSON.parse(readFileSync(args.capture, 'utf8'))
        : await takeCapture(liveAccount(process.env), cases.PARITY_QUERIES);
    if (!args.capture) {
        writeFileSync(join(out, 'capture.json'), JSON.stringify(capture), { mode: 0o600 });
    }
    const results = await cases.runParity(capture);
    const summary = cases.paritySummary(results);
    writeFileSync(
        join(out, 'report.json'),
        `${JSON.stringify(parityReport(summary, results, cases.serverIssues(capture)), null, 2)}\n`,
        { mode: 0o600 },
    );
    for (const line of summaryLines(summary)) {
        console.log(line);
    }
    process.exitCode = summary.pass ? 0 : 1;
}

if (import.meta.main) {
    main().catch((/** @type {Error} */ error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
