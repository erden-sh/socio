import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';

const name = `socio-isolation-api-${randomUUID()}`;
const token = randomBytes(32).toString('hex');
const docker = (args, options = {}) =>
    execFileSync('docker', args, {
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...options,
    });
try {
    docker(
        [
            'run',
            '-d',
            '--name',
            name,
            '--network',
            'none',
            '--cap-drop',
            'ALL',
            ...['CHOWN', 'SETUID', 'SETGID', 'KILL'].flatMap((c) => ['--cap-add', c]),
            '--security-opt',
            'no-new-privileges:true',
            '--pids-limit',
            '128',
            '--memory',
            '512m',
            '--env',
            'COMPUTER_TOKEN',
            '--env',
            'COMPUTER_SHELL_ENV=COMPUTER_TOKEN',
            process.env.COMPUTER_ISOLATION_TEST_IMAGE || 'company-brain-computer:b6932d3-isolated-v2',
        ],
        {
            env: { ...process.env, COMPUTER_TOKEN: token },
        },
    );
    const output = docker(
        ['exec', '-i', name, 'bun', '-e', 'await (new (async()=>{}).constructor(await Bun.stdin.text()))()'],
        {
            input: String.raw`
const token=process.env.COMPUTER_TOKEN;
for(let i=0;i<100;i++) {
  try { if((await fetch('http://localhost:4100/health')).ok) break; } catch {}
  await Bun.sleep(100);
}
const call=async(path,body,auth=true)=>{
  const r=await fetch('http://localhost:4100/'+path,{method:body?'POST':'GET',
    headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status, value:await r.json()};
};
const checks={};
const a={kind:'person',id:'fixture-a'}, b={kind:'person',id:'fixture-b'};
checks.protocol=(await call('health')).value.isolationVersion===1;
checks.requiresAuth=(await call('exec',{principal:a,command:'id'},false)).status===401;
checks.requiresIdentity=(await call('exec',{command:'id'})).status===400;
const ra=await call('exec',{principal:a,command:'id -u; pwd; printf private > private.txt; stat -c %a private.txt'});
const lines=ra.value.stdout?.trim().split('\n')||[];
checks.unprivileged=ra.status===200 && Number(lines[0])>=20001 && lines[2]==='600';
const home=lines[1];
const clean=await call('exec',{principal:a,command:'test -z "$COMPUTER_TOKEN" && printf clean'});
checks.dispatchCredentialNeverInherited=clean.value.stdout==='clean';
const rb=await call('exec',{principal:b,command:'cat '+JSON.stringify(home+'/private.txt')});
checks.shellDeniesSibling=rb.status===200 && rb.value.exitCode!==0;
checks.fileDeniesSibling=(await call('files/read',{principal:b,path:home+'/private.txt'})).status!==200;
checks.privateFilesWork=(await call('files/read',{principal:a,path:'private.txt'})).value.text==='private';
checks.sharedWrite=(await call('files/write',{principal:a,path:'shared/fixture.txt',contents:'shared'})).status===200;
checks.sharedRead=(await call('files/read',{principal:b,path:'shared/fixture.txt'})).value.text==='shared';
for(const kind of ['app','job']) {
  const r=await call('exec',{principal:{kind,id:'fixture-a'},command:'id -u; cat '+JSON.stringify(home+'/private.txt')});
  checks[kind+'Isolated']=r.status===200 && r.value.stdout?.trim()!==lines[0] && r.value.exitCode!==0;
}
const app={kind:'app',id:'server-fixture'};
await call('files/write',{principal:a,path:'shared/server.ts',contents:'Bun.serve({port:Number(process.env.PORT),hostname:"0.0.0.0",fetch(){return Response.json({uid:process.getuid(),hasToken:!!process.env.CB_DATA_TOKEN})}});'});
await call('files/write',{principal:app,path:'.socio/apps/test.env',contents:'PORT=3000\nCB_DATA_TOKEN=synthetic-fixture-only\n'});
const started=await call('exec',{principal:app,command:'set -a; . ./.socio/apps/test.env; set +a; (setsid nohup sh -c \'cd -- "$HOME/shared" && bun server.ts\' > app.log 2>&1 < /dev/null &)'});
let served;
for(let i=0;i<50;i++) { try { served=await fetch('http://localhost:3000').then(r=>r.json()); break; } catch {} await Bun.sleep(100); }
checks.backgroundAppWorks=started.status===200 && served?.uid>=20001 && served?.hasToken===true;
const job={kind:'job',id:'job-fixture'};
await call('files/write',{principal:job,path:'.socio/jobs/test/job.env',contents:'CB_DATA_TOKEN=synthetic-job-only\n'});
const ran=await call('exec',{principal:job,command:'set -a; . ./.socio/jobs/test/job.env; set +a; rm -f .socio/jobs/test/job.env; test -n "$CB_DATA_TOKEN" && printf job-ok'});
checks.jobEnvironmentWorks=ran.status===200 && ran.value.stdout==='job-ok';
if(Object.values(checks).some(v=>v!==true)) throw new Error(JSON.stringify(checks));
console.log(JSON.stringify({passed:true,checks}));
`,
        },
    );
    const result = JSON.parse(output.trim());
    if (!result.passed) {
        throw new Error('The isolated API checks failed.');
    }
    console.log(JSON.stringify(result));
} catch (error) {
    // Only synthetic test identities and boolean assertions can appear here.
    console.error(error.stderr?.toString() || error.message);
    process.exitCode = 1;
} finally {
    docker(['rm', '-f', name]);
}
