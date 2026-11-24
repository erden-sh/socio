import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { randomBytes } from 'node:crypto';
// CB-227: real Linux UID/permission checks against the pinned computer image.
// No production containers, networks or volumes are used.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const image = process.env.COMPUTER_ISOLATION_TEST_IMAGE || 'company-brain-computer:b6932d3-isolated-v2';
const name = `socio-principal-test-${randomBytes(6).toString('hex')}`;
const candidate = fileURLToPath(new URL('../deployment/computers', import.meta.url));
const input = readFileSync(new URL('../tests/fixtures/computer-isolation-kernel.mjs', import.meta.url));
try {
    const result = spawnSync(
        'docker',
        [
            'run',
            '-i',
            '--rm',
            '--name',
            name,
            '--network',
            'none',
            '--cap-drop',
            'ALL',
            '--cap-add',
            'CHOWN',
            '--cap-add',
            'SETUID',
            '--cap-add',
            'SETGID',
            '--cap-add',
            'KILL',
            '--security-opt',
            'no-new-privileges=true',
            '--pids-limit',
            '128',
            '--memory',
            '256m',
            '--mount',
            `type=bind,src=${candidate},dst=/candidate,readonly`,
            '--mount',
            `type=bind,src=${fileURLToPath(new URL('../packages/shared/src/job-entry.ts', import.meta.url))},dst=/job-source/entry.ts,readonly`,
            '--mount',
            `type=bind,src=${fileURLToPath(new URL('../src/server/schedules/startup-wait.ts', import.meta.url))},dst=/job-source/startup.ts,readonly`,
            '--entrypoint',
            'bun',
            image,
            '-',
        ],
        { input, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
    );
    if (result.status !== 0) {
        process.stderr.write(result.stderr || result.error?.message || 'Isolation smoke failed.\n');
        process.exitCode = 1;
    } else {
        const proof = JSON.parse(result.stdout.trim().split('\n').at(-1));
        if (!proof.passed || !Object.values(proof.checks).every((value) => value === true)) {
            throw new Error('The isolation checks did not all pass.');
        }
        console.log(JSON.stringify(proof, null, 2));
    }
} finally {
    // Only this invocation's disposable container. --rm normally did it.
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
}
