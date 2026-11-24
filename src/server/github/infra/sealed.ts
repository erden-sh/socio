/**
 * Where the GitHub App's sealed key lives (CB-322, CB-325): the App made by
 * "Connect GitHub", as a column `v`, for a recovery key check of a restored
 * copy of the database. Its rows are still in `dispatch_settings`; the
 * migration that drops that table moves them first (see infra/store.ts).
 */
export const GITHUB_SEALED_SQL = ["SELECT value AS v FROM dispatch_settings WHERE key='github.app'"] as const;
