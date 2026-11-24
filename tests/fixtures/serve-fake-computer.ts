// Testing only: a stand-in computer supervisor and computers for a local
// smoke of computer jobs (no Docker, nothing runs: each job "prints" the first
// echo line of its entry). Loopback only.
//
//   node --import tsx tests/fixtures/serve-fake-computer.ts [port]
//
// Then start the app with COMPUTER_SUPERVISOR_URL=http://127.0.0.1:<port>,
// COMPUTER_SUPERVISOR_TOKEN and COMPUTER_TOKEN set to any test values, and
// enable a Dot's computer (shell) in its settings.
import { createServer } from 'node:http';

import { FakeComputer } from './fake-computer.js';

const port = Number(process.argv[2] ?? 4514);
const computers = new Map<string, FakeComputer>();
const computer = (dotId: string) => {
    let found = computers.get(dotId);
    if (!found) {
        found = new FakeComputer(dotId, { port });
        found.wakeMs = 1500;
        found.behavior = ({ dir, files }) => {
            const entry = files.get(`${dir}/main.sh`) ?? files.get(`${dir}/main.ts`);
            const echo = /echo\s+["']?([^"'\n]*)/.exec(entry ?? '')?.[1];
            return { stdout: `${echo ?? 'done'}\n`, code: 0 };
        };
        computers.set(dotId, found);
    }
    return found;
};

const server = createServer((request, response) => {
    let body = '';
    request.on('data', (part) => (body += part));
    request.on('end', async () => {
        const url = `http://127.0.0.1:${port}${request.url}`;
        const init = {
            method: request.method,
            body: body || undefined,
        };
        let answer: Response;
        if (request.url === '/computers') {
            answer = Response.json({
                computers: [...computers.values()].map((item) => item.state()),
            });
        } else {
            const dotId =
                /^\/computers\/([^/]+)\//.exec(request.url ?? '')?.[1] ??
                String(request.headers['x-openbot-bot-id'] ?? '');
            answer = (await computer(dotId).handle(url, init)) ?? new Response('', { status: 404 });
        }
        response.writeHead(answer.status, {
            'Content-Type': answer.headers.get('content-type') ?? 'application/json',
        });
        response.end(await answer.text());
    });
});
server.listen(port, '127.0.0.1', () => console.log(`fake computers: COMPUTER_SUPERVISOR_URL=http://127.0.0.1:${port}`));
