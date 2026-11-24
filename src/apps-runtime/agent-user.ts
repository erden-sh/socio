/**
 * Runs a command as `user` with no capabilities, no supplementary groups and
 * `no_new_privs` (setuid binaries and file capabilities can't raise it
 * again). The runtime needs CAP_SETUID and CAP_SETGID for this.
 */
export const agentUserCommand = (user: string) => [
    'setpriv',
    `--reuid=${user}`,
    `--regid=${user}`,
    '--clear-groups',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--no-new-privs',
    '--',
];
