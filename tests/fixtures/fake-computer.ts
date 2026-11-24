/**
 * A stand-in for a Dot's computer and the supervisor (for the job tests): it
 * answers the computer API the app calls (list, ensure, files/write,
 * exec) and plays the commands a job run sends, keeping a small in-memory
 * workspace. Nothing leaves the process.
 */
export interface FakeRunContext {
    dir: string;
    /** The variables the command's prefix exported (the run's env file). */
    env: Record<string, string>;
    files: Map<string, string>;
    /** Resolves when the run is killed (the app's stop). */
    killed: Promise<void>;
}
export interface FakeRunResult {
    stdout?: string;
    stderr?: string;
    /** The exit code run.sh records; undefined: it never records one. */
    code?: number;
}

export const SUPERVISOR = 'http://127.0.0.1:4312';

export class FakeComputer {
    running = false;
    ensures = 0;
    /** How long the supervisor's ensure takes. */
    wakeMs = 0;
    files = new Map<string, string>();
    commands: string[] = [];
    kills = 0;
    /** Every file the app wrote, in order (paths and contents). */
    writes: Array<{ path: string; contents: string }> = [];
    /** What each run does; by default it prints its entry's name and exits 0. */
    behavior: (run: FakeRunContext) => Promise<FakeRunResult> | FakeRunResult = () => ({ stdout: 'ok\n', code: 0 });
    /** The env each run was launched with. */
    launches: Array<{ dir: string; env: Record<string, string> }> = [];
    private kill = new Map<string, () => void>();
    private inflight = new Set<Promise<void>>();
    /**
     * With `loopback`, the supervisor and the computer both answer on that
     * origin (`http://127.0.0.1:<port>`), as a local stand-in server does;
     * otherwise they are the computers network's names.
     */
    constructor(
        readonly dotId: string,
        private loopback?: { port: number },
    ) {}
    get supervisor() {
        return this.loopback ? `http://127.0.0.1:${this.loopback.port}` : SUPERVISOR;
    }
    get base() {
        // On loopback the app tells computers apart by the bot id header.
        return this.loopback
            ? `http://127.0.0.1:${this.loopback.port}`
            : `http://company-brain-computer-${this.dotId}:4100`;
    }
    state() {
        return {
            botId: this.dotId,
            container: `company-brain-computer-${this.dotId}`,
            status: this.running ? 'running' : 'stopped',
            ...(this.loopback ? { port: this.loopback.port } : { url: this.base }),
        };
    }
    /** Answers a request for the computer or the supervisor, else undefined. */
    handle(url: string, init?: RequestInit): Promise<Response> | undefined {
        if (!url.startsWith(this.supervisor) && !url.startsWith(this.base)) {
            return undefined;
        }
        // Like fetch, an aborted request rejects (the work goes on, as it would).
        const signal = init?.signal;
        return new Promise<Response>((resolve, reject) => {
            if (signal?.aborted) {
                return reject(signal.reason);
            }
            signal?.addEventListener('abort', () => reject(signal.reason), {
                once: true,
            });
            this.answer(url, init).then(resolve, reject);
        });
    }
    private async answer(url: string, init?: RequestInit) {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (url === `${this.supervisor}/computers`) {
            return Response.json({ computers: [this.state()] });
        }
        if (url === `${this.supervisor}/computers/${this.dotId}/ensure`) {
            this.ensures++;
            await new Promise((resolve) => setTimeout(resolve, this.wakeMs));
            this.running = true;
            return Response.json(this.state());
        }
        if (url === `${this.supervisor}/computers/${this.dotId}/stop`) {
            this.running = false;
            return Response.json({ ok: true });
        }
        if (url === `${this.base}/health`) {
            return Response.json({ isolationVersion: 1 });
        }
        if (!this.running) {
            return new Response('stopped', { status: 502 });
        }
        if (url === `${this.base}/files/write`) {
            this.files.set(body.path, body.contents);
            this.writes.push({ path: body.path, contents: body.contents });
            return Response.json({ ok: true });
        }
        if (url === `${this.base}/control`) {
            return Response.json({
                holder: 'bot',
                requested: false,
                transitioning: false,
                resumeSnapshotRequired: false,
            });
        }
        if (url === `${this.base}/exec`) {
            return Response.json(await this.exec(String(body.command)));
        }
        return new Response('not found', { status: 404 });
    }
    /** Plays one exec: an optional env prefix (sourced, then removed), then a command. */
    private async exec(raw: string) {
        this.commands.push(raw);
        const lines = raw.split('\n');
        const command = lines.at(-1)!;
        const env: Record<string, string> = {};
        if (lines.length > 1) {
            const file = /\. \.\/(\S+);/.exec(lines[0])?.[1];
            for (const line of (file && this.files.get(file))?.split('\n') ?? []) {
                const match = /^(\w+)='(.*)'$/.exec(line);
                if (match) {
                    env[match[1]] = match[2];
                }
            }
            if (file && lines[0].includes('rm -f')) {
                this.files.delete(file);
            }
        }
        const dir = /'(\.socio\/jobs\/[^']+?)\/(?:run\.sh|exit\.code|out\.log|job\.pid|job\.env)'/.exec(command)?.[1];
        if (command.startsWith('mkdir -p')) {
            return { stdout: '', exitCode: 0 };
        }
        if (command.startsWith('bash ') && dir) {
            await this.start(dir, env);
            return { stdout: '', exitCode: 0 };
        }
        if (command.startsWith('if command -v setsid') && dir) {
            void this.start(dir, env);
            return { stdout: 'started\n', exitCode: 0 };
        }
        if (command.startsWith('cat ') && dir) {
            const code = this.files.get(`${dir}/exit.code`);
            return {
                stdout: `${code ?? (command.includes('echo none') ? 'none' : 'running')}\n`,
                exitCode: 0,
            };
        }
        if (command.startsWith('tail ') && dir) {
            return {
                stdout: this.files.get(`${dir}/out.log`) ?? '',
                stderr: this.files.get(`${dir}/err.log`) ?? '',
                exitCode: 0,
            };
        }
        if (command.startsWith('P=$(cat') && dir) {
            this.kills++;
            this.kill.get(dir)?.();
            return { stdout: '', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
    }
    private start(dir: string, env: Record<string, string>) {
        this.launches.push({ dir, env });
        let killed!: () => void;
        const stop = new Promise<void>((resolve) => (killed = resolve));
        this.kill.set(dir, killed);
        const run = (async () => {
            const result = await Promise.race([
                Promise.resolve(this.behavior({ dir, env, files: this.files, killed: stop })),
                stop.then((): FakeRunResult => ({ code: 143 })),
            ]);
            this.files.set(`${dir}/out.log`, result.stdout ?? '');
            this.files.set(`${dir}/err.log`, result.stderr ?? '');
            if (result.code !== undefined) {
                this.files.set(`${dir}/exit.code`, `${result.code}\n`);
            }
        })();
        this.inflight.add(run);
        return run.finally(() => this.inflight.delete(run));
    }
}
