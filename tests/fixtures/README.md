# Learning delivery fixture

`learning-skills.zip` is a synthetic Intelligence skill snapshot, revision
`fixture-v1`. It contains `manifest.json` and `evidence-review/SKILL.md`; the
manifest records the content's size and SHA-256. ZIP entries have fixed timestamps.
It contains no real conversation data. The native SDK validates this archive in
the delivery integration test before exposing its catalog and tools to the model.

## Pinned OpenBot source

`openbot-b6932d3/` holds files of CopilotKit/OpenBot at revision
`b6932d31a8d6e7896c15139dfc27a6c6911deb27` (MIT, see
`deployment/computers/LICENSE.openbot`), unchanged, with `.txt` added so they
are not formatted, linted or type-checked here: the agent-computer's
`profiles.ts` and the modules it imports, the `/health` handler from its
`index.ts`, and the supervisor's `docker.ts`. `tests/computer-browser-limits.test.js`
applies the build-time patches in `deployment/computers` to them and runs the
patched `profiles.ts` on a fake Playwright.
