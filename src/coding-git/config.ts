import { readFileSync } from 'node:fs';

/**
 * The `coding-git` service's entry (CB-239): `CODING_GIT_SECRET` (or
 * `_FILE`, at least 24 characters, shared with the app only),
 * `CODING_GIT_DIR` (`/srv/coding-git`), `CODING_GIT_HOST` and
 * `CODING_GIT_PORT` (4350). It runs unprivileged, on an internal network
 * whose only other member is the app, with no route out.
 */
export function codingGitFromEnv(env: Record<string, string | undefined>) {
    const file = env.CODING_GIT_SECRET_FILE?.trim();
    const secret = (file ? readFileSync(file, 'utf8') : (env.CODING_GIT_SECRET ?? '')).trim();
    if (secret.length < 24) {
        throw new Error('Set CODING_GIT_SECRET (24+ characters) for coding-git.');
    }
    const port = Number(env.CODING_GIT_PORT?.trim() || 4350);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('CODING_GIT_PORT must be a port number.');
    }
    return {
        secret,
        port,
        host: env.CODING_GIT_HOST?.trim() || '0.0.0.0',
        dir: env.CODING_GIT_DIR?.trim() || '/srv/coding-git',
    };
}
