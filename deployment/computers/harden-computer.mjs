import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { replaceOnce } from './patch.mjs';

// CB-125: the computer's browser gets time limits. A close is cut off after
// CLOSE_LIMIT_MS and the browser's process group killed; page() checks that a
// browser answers before reusing it (a page that is only busy still counts),
// drops one that disconnected, never waits forever on a close, and always
// waits for a reset's deletion; /health reports `browserState` ("stuck" fails the
// healthcheck). The helpers live in browser-guard.ts, copied next to these.
// CB-157: screenshots can be asked for as JPEG (`screenshotEdits`).
// Everything else in the computer is the pinned upstream source.

const profileEdits = [
    [
        'import { botIdsIn } from "./profile-listing";',
        `import { botIdsIn } from "./profile-listing";
import { answers, browserPidFor, browserStateOf, CLOSING_WAIT_MS, closeOrKill, finishesWithin, killBrowser, LAUNCH_LIMIT_MS, startTimeOf } from "./browser-guard";`,
    ],
    [
        `async function closeAndWait(context: BrowserContext): Promise<void> {
  await context.close().catch(() => undefined);`,
        `async function closeAndWait(context: BrowserContext, kill: () => unknown = () => undefined): Promise<void> {
  // Socio (CB-125): a close a dead Chromium never answers is cut short and the browser killed.
  if ((await closeOrKill(context.close(), kill)) === "killed") return;`,
    ],
    [
        `    retarget: () => void;
  };`,
        `    retarget: () => void;
    /** Kill this browser's processes, for a close that does not finish (CB-125). */
    kill: () => boolean;
  };`,
    ],
    [
        'const closing = new Map<string, Promise<void>>();',
        `const closing = new Map<string, Promise<void>>();
  /** Since when a close or a launch has been in flight, for \`browserState\` (CB-125). */
  const closingSince = new Map<string, number>();
  const startingSince = new Map<string, number>();
  /** Resets in flight. Waited on in full, unlike a close: no browser may start on a profile being deleted. */
  const resetting = new Map<string, Promise<void>>();`,
    ],
    [
        '    closing.set(botId, held);',
        `    closing.set(botId, held);
    if (!closingSince.has(botId)) closingSince.set(botId, Date.now());`,
    ],
    [
        '        if (closing.get(botId) === held) closing.delete(botId);',
        `        if (closing.get(botId) === held) {
          closing.delete(botId);
          closingSince.delete(botId);
        }`,
    ],
    [
        'await closeAndWait(running.context).catch(() => undefined);',
        'await closeAndWait(running.context, running.kill).catch(() => undefined);',
    ],
    [
        `      // Only when something is closing: an unconditional await would let a stop slip in ahead of the launch.
      const closingNow = closing.get(botId);
      if (closingNow) await closingNow;`,
        `      // Socio (CB-125): looped, because the liveness check below waits, and whatever
      // changed meanwhile is decided again from the top.
      for (;;) {
      const resetNow = resetting.get(botId);
      if (resetNow) {
        await resetNow;
        continue;
      }
      // Only when something is closing: an unconditional await would let a stop slip in ahead of the launch.
      const closingNow = closing.get(botId);
      if (
        closingNow &&
        !(await finishesWithin(closingNow, CLOSING_WAIT_MS)) &&
        closing.get(botId) === closingNow
      ) {
        // Closes are cut off, so this is the last line: a close that still has not finished is
        // forgotten rather than waited on forever.
        closing.delete(botId);
        closingSince.delete(botId);
        console.info(JSON.stringify({ type: "computer-browser-close-abandoned", botId }));
      }`,
    ],
    [
        `      if (
        existing?.context.browser()?.isConnected() &&
        !existing.page.isClosed()
      ) {`,
        `      // A connected browser is not proof of a live one: a Chromium that died without Playwright
      // noticing still reads as connected, so the page has to answer too, or, when its script is
      // holding it, the browser process (CB-125). A busy page is handed out as it is.
      const alive =
        !!existing?.context.browser()?.isConnected() &&
        !existing.page.isClosed() &&
        (await answers(existing.page, existing.context.browser()));
      if (
        existing &&
        (live.get(botId) !== existing || closing.has(botId) || starting.has(botId))
      )
        continue;
      if (existing && alive) {`,
    ],
    [
        `        await existing.context.close().catch(() => undefined);
        live.delete(botId);`,
        `        //
        // Socio (CB-125): forgotten before anything is awaited, so callers arriving now
        // wait on the launch below, and killed rather than closed: a browser that does not answer
        // does not answer a close either, and upstream's unbounded close here could hang.
        live.delete(botId);
        existing.kill();
        void existing.context.close().catch(() => undefined);
        console.info(JSON.stringify({ type: "computer-browser-replaced", botId }));`,
    ],
    ['          viewport: VIEWPORT,', '          viewport: VIEWPORT,\n          timeout: LAUNCH_LIMIT_MS,'],
    [
        `          retarget: () => {},
        };`,
        `          retarget: () => {},
          kill: () => false,
        };
        const pid = browserPidFor(dir);
        // With its start time, so a pid reused by another program later is never killed.
        const startedAt = startTimeOf(pid);
        record.kill = () => killBrowser(pid, dir, startedAt);
        // A browser that went away is forgotten at once, so the next page() starts a new one
        // instead of handing out its dead page (CB-125).
        const forget = (reason: string) => {
          if (live.get(botId) !== record) return;
          live.delete(botId);
          console.info(JSON.stringify({ type: "computer-browser-gone", botId, reason }));
        };
        context.on("close", () => forget("its context closed"));
        context.browser()?.on("disconnected", () => forget("it disconnected"));`,
    ],
    [
        `      starting.set(botId, launch);
      try {
        return await launch;
      } finally {
        // Cleared whether it worked or not so a failed launch does not pin future calls to a rejected
        // promise.
        starting.delete(botId);
      }
    },`,
        `      starting.set(botId, launch);
      startingSince.set(botId, Date.now());
      try {
        return await launch;
      } finally {
        // Cleared whether it worked or not so a failed launch does not pin future calls to a rejected
        // promise.
        starting.delete(botId);
        startingSince.delete(botId);
      }
      }
    },`,
    ],
    [
        'await Promise.all(entries.map(([, c]) => closeAndWait(c.context)));',
        'await Promise.all(entries.map(([, c]) => closeAndWait(c.context, c.kill)));',
    ],
    [
        `    isLive(botId: string): boolean {
      return live.has(botId);
    },`,
        `    isLive(botId: string): boolean {
      return live.has(botId);
    },

    /** What this Bot's browser is doing; a close or launch that has run too long is "stuck" (CB-125). */
    browserState(botId: string) {
      return browserStateOf({
        running: live.has(botId),
        closingSince: closingSince.get(botId),
        startingSince: startingSince.get(botId),
      });
    },`,
    ],
    [
        `      await whileClosing(botId, async () => {
        await closeOnRequest(botId, "it was reset");
        await rm(directoryFor(botId), { recursive: true, force: true });
      });`,
        `      const removal = whileClosing(botId, async () => {
        await closeOnRequest(botId, "it was reset");
        await rm(directoryFor(botId), { recursive: true, force: true });
      });
      // Socio (CB-125): page() stops waiting on a close after a while, but never on a
      // reset, so a deletion that runs long is not raced by a launch into the same directory.
      const held = Promise.all([resetting.get(botId), removal]).then(
        () => undefined,
        () => undefined,
      );
      resetting.set(botId, held);
      void held.then(() => {
        if (resetting.get(botId) === held) resetting.delete(botId);
      });
      await removal;`,
    ],
];

const indexEdits = [
    [
        '          browser: profile?.running ?? false,',
        `          browser: profile?.running ?? false,
          // Socio (CB-125): the container's healthcheck fails when this is "stuck".
          browserState: profiles.browserState(botId),`,
    ],
];

// CB-157: `GET /screenshot?type=jpeg&quality=80` answers with a JPEG, about a
// tenth of the PNG's size for a page, so a socio's screenshot can go to its
// model as an image. Without `type=jpeg` it is the PNG, as before.
const screenshotEdits = [
    [
        '          const buffer = await target.screenshot({ type: "png" });',
        `          // Socio (CB-157): a JPEG when asked for one, at a quality from 30 to 95.
          const jpeg = url.searchParams.get("type") === "jpeg";
          const quality = Math.min(95, Math.max(30, Math.round(Number(url.searchParams.get("quality")) || 80)));
          const buffer = await target.screenshot(jpeg ? { type: "jpeg", quality } : { type: "png" });`,
    ],
];

const apply = (source, edits, contract) =>
    edits.reduce((text, [before, after]) => replaceOnce(text, before, after, contract), source);

export const hardenComputerProfiles = (source) => apply(source, profileEdits, 'browser profiles');
export const hardenComputerIndex = (source) => apply(source, indexEdits, 'computer health');
export const jpegScreenshots = (source) => apply(source, screenshotEdits, 'computer screenshot');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const dir = process.argv[2];
    if (!dir) throw new Error('Pass the pinned agent-computer src directory.');
    for (const [file, harden] of [
        ['profiles.ts', hardenComputerProfiles],
        ['index.ts', (source) => jpegScreenshots(hardenComputerIndex(source))],
    ]) {
        const path = join(dir, file);
        await writeFile(path, harden(await readFile(path, 'utf8')));
    }
}
