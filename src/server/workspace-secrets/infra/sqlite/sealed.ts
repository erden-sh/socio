/**
 * Where Socio Secrets keep sealed values (CB-322): every version, retired
 * and deleted ones too, as a column `v`, for a recovery key check of a
 * restored copy of the database.
 */
export const WORKSPACE_SECRETS_SEALED_SQL = ['SELECT sealed AS v FROM workspace_secret_versions'] as const;
