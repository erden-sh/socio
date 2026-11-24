/**
 * `@copilotkit/web-inspector` is never the app's: Vite and vitest alias it to
 * packages/client/src/no-web-inspector.ts, and pnpm doesn't put it where the tests
 * resolve from (CB-183). tests/integration/telemetry.test.ts imports it to check the
 * alias.
 */
declare module '@copilotkit/web-inspector';
