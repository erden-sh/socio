/**
 * Where the platform writes each computer command's data token, one file
 * per command (relative to the workspace); the command deletes it first.
 */
export const COMPUTER_RUN_DIR = '.socio/run';
/** Where computers before CB-224 kept a shared token; deleted on sight. */
export const LEGACY_COMPUTER_ENV_FILE = '.socio/data.env';
