import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { randomUUID, randomBytes } from 'node:crypto';
import process from 'node:process';

const namespace = `isolation-${randomUUID()}`;
const supervisor = `${namespace}-supervisor`;
const computer = `${namespace}-computer-fixture`;
const volumes = ['profile', 'workspace', 'private'].map((kind) => `${namespace}-${kind}-fixture`);
const docker = (args, extra = {}) =>
    execFileSync('docker', args, {
        encoding: 'utf8',
        timeout: 90000,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...extra,
    });
const run = (container, code) =>
    JSON.parse(
        docker(
            ['exec', '-i', container, 'bun', '-e', 'await (new (async()=>{}).constructor(await Bun.stdin.text()))()'],
            { input: code },
        ).trim(),
    );
try {
    docker(
        [
            'run',
            '-d',
            '--name',
            supervisor,
            '--network',
            'none',
            '--env',
            'SUPERVISOR_TOKEN',
            '--env',
            'COMPUTER_TOKEN',
            '--env',
            `COMPUTER_NAMESPACE=${namespace}`,
            '--env',
            'COMPUTER_NETWORK=',
            '--env',
            `COMPUTER_IMAGE=${process.env.COMPUTER_ISOLATION_TEST_IMAGE || 'company-brain-computer:b6932d3-isolated-v2'}`,
            '--volume',
            '/var/run/docker.sock:/var/run/docker.sock',
            process.env.SUPERVISOR_ISOLATION_TEST_IMAGE || 'company-brain-supervisor:b6932d3-dot-auth-isolated-v2',
        ],
        {
            env: {
                ...process.env,
                SUPERVISOR_TOKEN: randomBytes(32).toString('hex'),
                COMPUTER_TOKEN: randomBytes(32).toString('hex'),
            },
        },
    );
    const ensure = () =>
        run(
            supervisor,
            `
for(let i=0;i<100;i++) { try { await fetch('http://localhost:4300/health'); break; } catch { /* already absent */ } await Bun.sleep(100); }
const r=await fetch('http://localhost:4300/computers/fixture/ensure',{method:'POST',headers:{Authorization:'Bearer '+process.env.SUPERVISOR_TOKEN}});
if(!r.ok) throw new Error('Fixture ensure failed with HTTP '+r.status);
const body=await r.json(); console.log(JSON.stringify({running:body.status==='running'}));
`,
        );
    const checks = { supervisorCreatesComputer: ensure().running };
    const config = JSON.parse(docker(['inspect', computer, '--format', '{{json .HostConfig}}']));
    checks.onlyDispatcherCapabilities =
        JSON.stringify(config.CapAdd.map((c) => c.replace(/^CAP_/, '')).sort()) ===
        JSON.stringify(['CHOWN', 'KILL', 'SETGID', 'SETUID']);
    checks.dropsAll = config.CapDrop.includes('ALL');
    checks.noNewPrivileges = config.SecurityOpt.includes('no-new-privileges:true');
    checks.privateVolume = config.Binds.includes(`${volumes[2]}:/private`);
    const identity = () =>
        run(
            computer,
            `
const r=await fetch('http://localhost:4100/exec',{method:'POST',headers:{Authorization:'Bearer '+process.env.COMPUTER_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({principal:{kind:'person',id:'fixture'},command:'id -u; test -f saved || printf retained > saved; cat saved'})});
if(!r.ok) throw new Error('Fixture command failed');
const v=await r.json(); console.log(JSON.stringify({uid:Number(v.stdout.split('\\n')[0]),retained:v.stdout.endsWith('retained')}));
`,
        );
    const before = identity();
    checks.workerUnprivileged = before.uid >= 20001;
    docker(['rm', '-f', computer]);
    checks.recreatesComputer = ensure().running;
    const after = identity();
    checks.replacementRetainsPrivateIdentity = before.uid === after.uid && after.retained;
    if (Object.values(checks).some((v) => v !== true)) {
        throw new Error(JSON.stringify(checks));
    }
    console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
    console.error(error.stderr?.toString() || error.message);
    process.exitCode = 1;
} finally {
    // Only resources in this invocation's random namespace are removed.
    for (const name of [computer, supervisor]) {
        try {
            docker(['rm', '-f', name]);
        } catch {
            /* already absent */
        }
    }
    for (const name of volumes) {
        try {
            docker(['volume', 'rm', name]);
        } catch {
            /* already absent */
        }
    }
}
