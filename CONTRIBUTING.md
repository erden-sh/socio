# Contributing to Socio

Thanks for your interest in Socio. It is in early development, so expect things to move.

Report security issues privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.

## Issues

For a bug, include how you run Socio (development or a built image), your Node version, the steps to reproduce, what you expected and what happened. Remove credentials and private page content from logs and screenshots.

For a feature, describe the workflow you want before proposing an implementation.

## Pull requests

[AGENTS.md](AGENTS.md) has the project map, the commands and the conventions the checks enforce; it applies to people too. Before you open a pull request:

- Run `pnpm run check`, `pnpm test` and `pnpm run build`, and see them pass.
- Add regression tests for changes to durable jobs, permissions, cancellation or API behavior.
- Try changed UI yourself, including narrow screens and keyboard access.
- Update [docs/SETUP.md](docs/SETUP.md) and [.env.example](.env.example) when configuration or dependencies change.
- Keep credentials, local databases, generated reports and personal data out of commits.
- Keep the app free of vendor telemetry, and don't add a control that looks like it connects a service when nothing behind it does.

Text: there is no i18n yet. Sort and format text with the helpers in `packages/shared/src/locale.ts`, which use `en-US` on the server and in every browser so server-rendered pages hydrate without a mismatch, and show times with `<LocalTime>` (`packages/client/src/lib/local-time.tsx`).

## Contributor License Agreement

Before your first pull request can be merged, you sign Ingenio Ventures Inc.'s [Contributor License Agreement](CLA.md), once. It lets Ingenio use, distribute and relicense your contributions, and covers any of your patents they need; you keep the copyright. On your pull request, the CLA check asks you to post this comment:

> I have read the CLA Document and I hereby sign the CLA

The check then records your signature and passes, and it won't ask again on later pull requests. Every commit in the pull request must be linked to a GitHub account (its email must be one of your account's), and everyone who authored a commit in it signs. If the check doesn't update, comment `recheck`. If you contribute as part of your job, make sure your employer allows it (section 5 of the agreement).

## License

Project code is © Ingenio Ventures Inc., under the Sustainable Use License in [LICENSE](LICENSE). Contributions are licensed to Ingenio under the [CLA](CLA.md). Third-party code keeps its own license: preserve the notices of any third-party code or assets you contribute, and list them in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
