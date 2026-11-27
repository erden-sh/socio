#!/usr/bin/env node
// Format, lint, typecheck and the dictionaries' checks at once (CB-311): they read the same files and
// none needs another's output, so they run in parallel and the slowest one
// sets the time. Each one's output is printed whole when it ends, so logs
// never interleave; the exit status is the first failure's.
//
//   node scripts/check.mjs            # all of them
//   node scripts/check.mjs lint       # some of them
import { spawn } from 'node:child_process';

const CHECKS = {
    format: ['pnpm', ['run', '--silent', 'check-format']],
    lint: ['pnpm', ['run', '--silent', 'lint']],
    typecheck: ['pnpm', ['run', '--silent', 'typecheck']],
    // The dictionaries' checks, without writing dist/i18n (scripts/i18n-build.mjs).
    i18n: ['pnpm', ['run', '--silent', 'check:i18n']],
};

const wanted = process.argv.slice(2);
for (const name of wanted) {
    if (!(name in CHECKS)) {
        console.error(`Unknown check: ${name} (${Object.keys(CHECKS).join(', ')})`);
        process.exit(2);
    }
}
const names = wanted.length ? wanted : Object.keys(CHECKS);

const run = (name) =>
    new Promise((resolve) => {
        const started = performance.now();
        const [command, args] = CHECKS[name];
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', (chunk) => chunks.push(chunk));
        child.on('error', (error) => chunks.push(Buffer.from(`${error}\n`)));
        child.on('close', (code) => {
            const seconds = ((performance.now() - started) / 1000).toFixed(1);
            const output = Buffer.concat(chunks).toString().trimEnd();
            console.log(`── ${name}: ${code === 0 ? 'ok' : `failed (${code})`} in ${seconds} s`);
            if (output && code !== 0) {
                console.log(output);
            }
            resolve(code ?? 1);
        });
    });

const codes = await Promise.all(names.map(run));
process.exit(codes.find((code) => code !== 0) ?? 0);
