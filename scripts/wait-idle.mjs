#!/usr/bin/env node
// Waits until a deployment has no agent turn in progress.
// Since CB-37 the app drains on SIGTERM (running turns finish, up to
// SHUTDOWN_DRAIN_MS), so a deploy no longer needs this to spare a turn. It
// still helps before replacing a build without draining, and to avoid a
// minute of "updating, try again" replies:
//
//   node scripts/wait-idle.mjs --base https://brain.example.test --admin-email E --password-file F [--insecure] [--timeout 600] [--force]
//
// It signs in with an admin test account (Better Auth); against a local
// mock-auth server it signs in as its first admin (or --admin-user).
//
// --force (development servers only, APP_ENV=development): stops all running
// work first, so the deploy doesn't wait for it, holds new work until the
// restart, then waits until idle (seconds). The account must be an admin,
// like the other platform controls (CB-390).
import { readFileSync } from 'node:fs';

import { authProvider, mockUserId, parseArgs, signIn } from './lib/brain-client.mjs';
import { waitIdle } from './lib/wait-idle.mjs';

const args = parseArgs(process.argv.slice(2));
if (args.insecure === 'true') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const force = args.force === 'true';
let user = args['admin-user'];
if ((await authProvider(args.base)) === 'betterauth') {
    if (!args['admin-email'] || !args['password-file']) {
        throw new Error(
            `This server uses Better Auth: pass --admin-email and --password-file for an admin test account.`,
        );
    }
    user = {
        email: args['admin-email'],
        password: readFileSync(args['password-file'], 'utf8').trim(),
    };
} else {
    user ??= await mockUserId(args.base, 'admin');
}
const admin = await signIn(args.base, user);
const idle = await waitIdle(admin, {
    force,
    timeoutMs: Number(args.timeout ?? 600) * 1000,
});
if (!idle) {
    process.exit(1);
}
