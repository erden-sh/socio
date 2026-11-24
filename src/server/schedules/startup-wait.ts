/**
 * The wrapper script of one job run (`run.sh`). First, while the app starts
 * (CB-161), it waits for the app: a GET of `/healthz`, retried when the
 * connection is refused (and on curl's transient statuses) with a growing
 * wait, for at most `waitSeconds`. Then it runs the job as it always did,
 * its own `fetch` and `curl` calls untouched. If the app never answers, the
 * run fails at once and says so, as a refused connection.
 */
export function runScript(input: {
    /** The job's command, e.g. `bun ./main.ts`. */
    command: string;
    /** The job's timeout in seconds. */
    seconds: number;
    /** The most the wait for the app may take. */
    waitSeconds: number;
}): string {
    const wait = Math.max(0, Math.floor(input.waitSeconds));
    return [
        'cd "$(dirname "$0")" || exit 1',
        // No data API (CB_DATA_URL unset), no wait. The app's address is the
        // data API's without its path.
        ...(wait
            ? [
                  `if [ -n "\${CB_DATA_URL:-}" ] && command -v curl >/dev/null 2>&1; then`,
                  `  curl -s -o /dev/null --max-time 5 --retry 100 --retry-connrefused --retry-max-time ${wait} "\${CB_DATA_URL%/api/data}/healthz" || {`,
                  `    echo "Connection refused: the app at \${CB_DATA_URL%/api/data} did not answer within ${wait} s." > err.log`,
                  '    echo 1 > exit.code',
                  '    exit 1',
                  '  }',
                  'fi',
              ]
            : []),
        // timeout leads its own process group, so a stop reaches the whole job.
        `timeout -k 5 ${input.seconds} ${input.command} > out.log 2> err.log < /dev/null &`,
        'echo $! > job.pid',
        'wait $!',
        'echo $? > exit.code',
        '',
    ].join('\n');
}
