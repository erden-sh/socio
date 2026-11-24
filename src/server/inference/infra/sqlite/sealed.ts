/**
 * Where inference keeps sealed values (CB-322): backends' keys, people's
 * subscription credentials and the environment's seed, each as a column
 * `v`. A recovery key check reads them from a restored copy of the
 * database, so the SQL stays here, inside inference's infra.
 */
export const INFERENCE_SEALED_SQL = [
    'SELECT secrets AS v FROM inference_backends WHERE secrets IS NOT NULL',
    'SELECT credentials AS v FROM user_inference_connections',
    "SELECT value AS v FROM inference_settings WHERE key='envSeed'",
] as const;
