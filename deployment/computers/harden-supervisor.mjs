import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { replaceOnce } from './patch.mjs';

// Fail closed if the pinned upstream contract changes. Only child authentication
// and resource reads change; OpenBot retains container creation, volumes and lifecycle.
export function hardenSupervisorEnvironment(source) {
    return `import { createHmac } from "node:crypto";\n${replaceOnce(
        source,
        'const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;',
        `const master = env.COMPUTER_TOKEN?.trim();
  if (!master || master.length < 24) throw new Error("COMPUTER_TOKEN must contain at least 24 characters.");
  const computerToken = createHmac("sha256", master).update("company-brain-computer:" + botId).digest("hex");`,
        'environment',
    )}`;
}

// CB-125: the computers this supervisor creates get an init process, which
// reaps the zombies Chromium leaves (PID 1 is otherwise `bun src/index.ts`);
// their healthcheck fails when the computer's browser is stuck; and the
// listing reports each computer's health. Existing containers keep their old
// settings until the supervisor creates them again.
export const hardenSupervisorNames = (source) =>
    [
        ['  workspaceVolume: string;', '  workspaceVolume: string;\n  privateVolume: string;'],
        [
            '      workspaceVolume: `${NAMESPACE}-workspace-${botId}`,',
            '      workspaceVolume: `${NAMESPACE}-workspace-${botId}`,\n      privateVolume: `${NAMESPACE}-private-${botId}`,',
        ],
    ].reduce((text, [before, after]) => replaceOnce(text, before, after, 'private volume names'), source);

const dockerEdits = [
    [
        '      `${names.workspaceVolume}:/workspace`,',
        '      `${names.workspaceVolume}:/workspace`,\n      `${names.privateVolume}:/private`,',
    ],
    [
        '[names.profileVolume, names.workspaceVolume]',
        '[names.profileVolume, names.workspaceVolume, names.privateVolume]',
    ],
    [
        '    CapDrop: ["ALL"],',
        '    CapDrop: ["ALL"],\n    // Only the trusted dispatcher retains these; workers drop every capability.\n    CapAdd: ["CHOWN", "SETUID", "SETGID", "KILL"],',
    ],
    [
        `process.exit(r.ok ? 0 : 1)"\`,`,
        `const j = await r.json(); process.exit(r.ok && j.browserState !== 'stuck' ? 0 : 1)"\`,`,
    ],
    [
        `  url?: string;
};`,
        `  url?: string;
  /** Docker's health of the computer: "unhealthy" when its browser is stuck (CB-125). */
  health?: "starting" | "healthy" | "unhealthy";
};

/** The health in a listed container's status, such as "Up 2 hours (unhealthy)". */
function healthOf(status: string | undefined): ComputerState["health"] {
  const match = /\\((healthy|unhealthy|health: starting)\\)/.exec(status ?? "");
  if (!match) return undefined;
  return match[1] === "health: starting" ? "starting" : (match[1] as "healthy" | "unhealthy");
}`,
    ],
    [
        '      status: container.State,',
        `      status: container.State,
      ...(healthOf(container.Status) ? { health: healthOf(container.Status) } : {}),`,
    ],
    [
        '    RestartPolicy: { Name: "unless-stopped" },',
        `    RestartPolicy: { Name: "unless-stopped" },
    // An init as PID 1 reaps the processes Chromium leaves behind (CB-125).
    Init: true,`,
    ],
];

export const hardenSupervisorDocker = (source) =>
    `${replaceOnce(
        dockerEdits.reduce((text, [before, after]) => replaceOnce(text, before, after, 'docker'), source),
        'import Docker from "dockerode";',
        'import Docker from "dockerode";\nimport { readComputerStats } from "./resource-stats.mjs";\nimport { destroyComputer } from "./computer-destroy.mjs";',
        'resource stats import',
    )}

// Container reads only: volume sizes come from the disk usage proxy (CB-197).
const resourceDocker = {
  getContainer: (name: string) => docker.getContainer(name),
};
export async function computerStats(names: ComputerNames) {
  try { return await readComputerStats(resourceDocker, names, ours, BOT_LABEL); }
  catch { throw new DockerUnavailableError("resource measurements unavailable"); }
}

// A purged socio's computer, container and all three volumes, each only if ours (computer-destroy.mjs).
export async function computerDestroy(names: ComputerNames) {
  try { return await destroyComputer(docker, names, ours, BOT_LABEL); }
  catch (error) {
    if (Object(error).refused) throw error;
    throw new DockerUnavailableError(String(error));
  }
}
`;

export function hardenSupervisorRoutes(source) {
    return replaceOnce(
        replaceOnce(source, '  listOwned,', '  listOwned,\n  computerStats,\n  computerDestroy,', 'stats route import'),
        'app.get("/computers", async (context) => {',
        `app.get("/computers/:botId/stats", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const stats = await computerStats(parsed.names);
    return stats ? context.json(stats) : context.json({ error: "Computer not found." }, 404);
  } catch { return context.json({ error: "Computer resource measurements unavailable." }, 503); }
});

// Socio's operator purge: removes a gone socio's computer, container and volumes.
app.post("/computers/:botId/destroy", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    return context.json(await computerDestroy(parsed.names));
  } catch (error) {
    if (Object(error).refused) return context.json({ error: "Not this supervisor's computer." }, 409);
    return context.json({ error: "Computer service unavailable." }, 503);
  }
});

app.get("/computers", async (context) => {`,
        'stats route',
    );
}

// CB-239: the coding sandboxes' fixed-spec API (coding-sandbox.mjs),
// mounted after the token check, so only SUPERVISOR_TOKEN holders reach it.
// It uses its own Docker client and its own labels, so OpenBot's computer
// verbs and listing never see a sandbox.
export function hardenSupervisorSandboxes(source) {
    return replaceOnce(
        replaceOnce(
            source,
            'import { listenPort } from "./listen-port";',
            `import { listenPort } from "./listen-port";
import Docker from "dockerode";
import { mountCodingSandboxes } from "./coding-sandbox.mjs";
import { NAMESPACE } from "./names";`,
            'sandbox imports',
        ),
        'serve({ port, fetch: app.fetch, idleTimeout: 120 });',
        `mountCodingSandboxes(app, {
  docker: new Docker(process.env.DOCKER_SOCKET ? { socketPath: process.env.DOCKER_SOCKET } : undefined),
  env: process.env,
  namespace: NAMESPACE,
});

serve({ port, fetch: app.fetch, idleTimeout: 120 });`,
        'sandbox routes',
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const dir = process.argv[2];
    if (!dir) throw new Error('Pass the pinned supervisor src directory.');
    for (const [file, harden] of [
        ['environment.ts', hardenSupervisorEnvironment],
        ['names.ts', hardenSupervisorNames],
        ['docker.ts', hardenSupervisorDocker],
        ['index.ts', (source) => hardenSupervisorSandboxes(hardenSupervisorRoutes(source))],
    ]) {
        const path = join(dir, file);
        await writeFile(path, harden(await readFile(path, 'utf8')));
    }
}
