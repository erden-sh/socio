# Socio

**Your team's workspace, with AI socios.** Chat, rooms, pages, a board and approvals in one place. Socios do the busywork and ask before anything that matters. On the web and on your phone.

- **Chats and rooms:** talk to a socio one on one, or bring people and socios into a room and hand work between them.
- **Spaces and pages:** your handbook, client notes and plans, written together. Socios read them before they answer.
- **The board:** bugs, requests and to-dos in one place. Anyone can file, vote and comment, socios too.
- **Approvals:** socios ask before they send, pay or publish. You approve from your phone in a tap.
- **Memories and schedules:** socios remember what matters to your team and run the tasks you set.
- **Your socios:** give each one a name, a character and a job, and connect any OpenAI-compatible model.

Learn more at [socio.sh](https://socio.sh).

## Looking for Socio, not its code?

This repository is the source code. If you want Socio for your team without running servers, **[hosted Socio](https://socio.sh/hosted)** is run by Ingenio Ventures, the team that builds it: a private workspace set up for you, with daily backups, updates and a person to talk to. Hosted Socio is in early access: [join the waitlist](https://socio.sh/hosted#waitlist).

To run it yourself on your own servers, see [docs/SETUP.md](docs/SETUP.md).

## License

Socio is source-available under the [Sustainable Use License](LICENSE), the model n8n uses. In plain words:

- **You can** run Socio for your own company or team, on your own servers, at no cost; change the code to fit how you work; use it for personal and non-commercial projects; and share it free of charge for non-commercial purposes, with the license attached.
- **You can't** sell Socio, or a modified copy, as a product or hosted service, or charge others for access to a Socio you run for them.

This summary isn't the license; [LICENSE](LICENSE) is. Want to offer Socio commercially? Ask about a commercial license at [support@ingenioventures.com](mailto:support@ingenioventures.com) or [socio.sh/support](https://socio.sh/support#contact).

Socio is © 2026 Ingenio Ventures Inc. It started from [OpenDots](https://github.com/CopilotKit/OpenDots) at `565bf78` (MIT, © Atai Barkai), imported without upstream history; the code that comes from OpenDots stays under its MIT license. The computer services come from [OpenBot](https://github.com/CopilotKit/OpenBot) (MIT, © CopilotKit). Both upstream notices are retained: see [LICENSE](LICENSE), `deployment/computers/LICENSE.openbot` and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES), which also lists the code adapted from other projects. Every image carries `LICENSE` and `THIRD_PARTY_NOTICES`.

The ontology in [`ontology/`](ontology/) is licensed separately, under [CC BY-NC-SA 4.0](ontology/LICENSE).

Socio, Socio.sh, Erden, and Erden.sh are trademarks of Ingenio Ventures Inc. The license grants no rights to them.

## Development

You need Node 26.13.0 (in `.nvmrc`) and pnpm 10.15.0 (`corepack enable pnpm`), and an OpenAI-compatible model server.

```sh
pnpm install --frozen-lockfile
cp .env.example .env    # set OPENAI_BASE_URL and OPENAI_MODEL
pnpm run dev            # http://127.0.0.1:4310
```

In development you sign in as `alice` (admin) or `bob` (member). Before a pull request:

```sh
pnpm run check          # format, lint and typecheck
pnpm test               # the test suite
pnpm run build          # the production build
```

Every setting is in [.env.example](.env.example) and [docs/SETUP.md](docs/SETUP.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Coding agents: [AGENTS.md](AGENTS.md). Security reports: [SECURITY.md](SECURITY.md).

Socio sends no vendor telemetry: CopilotKit's analytics senders are replaced with do-nothing packages in `vendor/`, and the tests block every network connection except loopback. See [SECURITY.md](docs/SECURITY-ARCHITECTURE.md#vendor-telemetry).
