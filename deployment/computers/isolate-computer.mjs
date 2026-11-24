import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { replaceOnce } from './patch.mjs';

// Every non-browser operation crosses the UID boundary. Missing identity is
// an error, including for old callers; there is no root execution fallback.
export function isolateComputer(source) {
    const edits = [
        [
            'import { mkdir, rm, writeFile } from "node:fs/promises";',
            'import { mkdir, rm, writeFile, lstat, chown, chmod } from "node:fs/promises";',
        ],
        [
            'import { createShell } from "./shell";',
            'import { environmentForCommand } from "./shell";\nimport { PrincipalRuntime } from "./principal-runtime";',
        ],
        [
            'const workspace = createWorkspace(\n  process.env.WORKSPACE_DIR?.trim() || "/workspace",\n);',
            `const sharedRoot = process.env.WORKSPACE_DIR?.trim() || "/workspace";
const sharedInfo = await lstat(sharedRoot);
if (!sharedInfo.isDirectory() || sharedInfo.isSymbolicLink() || sharedInfo.uid !== 0)
  throw new Error("The shared workspace must be a root-owned directory.");
await chown(sharedRoot, 0, 20000);
await chmod(sharedRoot, 0o2770);
const commandEnvironment = environmentForCommand(process.env, "/workspace");
// A legacy shell allow-list must never hand the dispatcher credential to a worker.
for (const [name, value] of Object.entries(commandEnvironment))
  if (name === "COMPUTER_TOKEN" || name === "SUPERVISOR_TOKEN" || value === COMPUTER_TOKEN)
    delete commandEnvironment[name];
const principals = new PrincipalRuntime({
  privateRoot: "/private",
  sharedRoot: process.env.WORKSPACE_DIR?.trim() || "/workspace",
  workerFile: import.meta.dir + "/principal-worker.ts",
  environment: commandEnvironment,
});`,
        ],
        [
            'const shell = createShell(process.env.WORKSPACE_DIR?.trim() || "/workspace");',
            '// Shells are created only inside an unprivileged principal worker.',
        ],
        [
            '          browser: profile?.running ?? false,',
            '          browser: profile?.running ?? false,\n          isolationVersion: 1,',
        ],
    ];
    let result = edits.reduce(
        (text, [before, after]) => replaceOnce(text, before, after, 'computer isolation'),
        source,
    );
    const start = result.indexOf("      // The Bot's files. Confined to the workspace");
    const end = result.indexOf('      // The current page as text, without navigating anywhere.', start);
    if (start < 0 || end < 0) throw new Error('Computer isolation route contract changed.');
    result =
        result.slice(0, start) +
        `      // Identity arrives only from the authenticated application gateway.
      const isolatedOperation = {
        "/exec": "exec", "/files/read": "files_read",
        "/files/write": "files_write", "/files/list": "files_list",
      }[url.pathname];
      if (isolatedOperation && request.method === "POST") {
        if (isolatedOperation === "exec" && !RUNTIME.allowExec)
          return json({ error: "Shell execution is disabled." }, 403);
        const body = await request.json().catch(() => null);
        if (!body || !body.principal)
          return json({ error: "An execution principal is required." }, 400);
        if (isolatedOperation === "exec") {
          const timeout = parseExecTimeout(body.timeoutMs);
          if (!timeout.ok) return json({ error: timeout.error }, 400);
          body.timeoutMs = timeout.timeoutMs;
        }
        try {
          return json(await principals.dispatch(body.principal, isolatedOperation, body, { signal: request.signal }));
        } catch {
          return json({ error: "The isolated computer operation failed." }, 400);
        }
      }

` +
        result.slice(end);
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const path = join(process.argv[2], 'index.ts');
    await writeFile(path, isolateComputer(await readFile(path, 'utf8')));
}
