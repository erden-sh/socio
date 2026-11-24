/**
 * The app browser's deployment, as data (CB-232): the image
 * stage's process, a swarm overlay's services and network, the
 * local compose service and the seccomp profile Chromium's sandbox needs.
 * The checked-in files (deployment/app-browser/seccomp.json, .docker/compose.yml,
 * Dockerfile) are kept equal to these by tests/app-browser-spec.test.ts.
 * Not deployed by default.
 *
 * The boundary they draw:
 * - The service's only network is an internal overlay shared with the
 *   app alone: no route out, no DNS answers for outside names, no other
 *   peer. Chromium inside also resolves nothing and proxies to nowhere
 *   (launch.ts), and every request it makes is fulfilled by the worker.
 * - The router starts as `node` with just the capabilities to run each
 *   context's worker as its own user and stop it (SETUID, SETGID, KILL);
 *   workers have none and no new privileges.
 * - Chromium's sandbox needs user namespaces, which Docker's default
 *   seccomp profile refuses to a process without CAP_SYS_ADMIN. The
 *   service gets the profile below instead of CAP_SYS_ADMIN; without it
 *   Chromium won't start sandboxed, the router's self-test fails, and the
 *   service refuses to serve rather than run unsandboxed.
 */

export const APP_BROWSER_PORT = 4360;
/** Each context's worker runs as UID base + slot; slot `max` is the self-test's. */
export const APP_BROWSER_UID_BASE = 21000;
/** Users the image creates: slots 0..64 (APP_BROWSER_MAX is at most 64). */
export const APP_BROWSER_USERS = 65;
/** Socio's internal apps listener as the app browser reaches it. */
export const APP_BROWSER_UPSTREAM_ALIAS = 'company-brain-apps-internal';
export const APP_BROWSER_UPSTREAM_PORT = 4312;
/** The secret's key in the stack file, and the file name under /run/secrets. */
export const APP_BROWSER_SECRET_NAME = 'company_brain_app_browser_secret';
/**
 * The Swarm secret's name. Swarm names are global per swarm, so a second
 * deployment on the same swarm sets its own (CB-327); unset, the default one.
 */
export const APP_BROWSER_SECRET_SWARM_NAME = `\${APP_BROWSER_SECRET_SWARM_NAME:-${APP_BROWSER_SECRET_NAME}}`;

/**
 * The `app_browser` overlay's fixed IPv4 subnet, which the app's internal
 * apps listener also gets as `APPS_INTERNAL_SUBNET`: a connection to port
 * 4312 from any other address is refused before a byte is read, though the
 * app sits on many networks. Private and clear of the repository's other
 * ranges (the coding sandboxes' 10.213.0.0/16, the swarm's default pool's
 * low 10.0.x.0/24s, Docker's 172.17–31 bridges); stack env
 * `APP_BROWSER_SUBNET` overrides it if the host already uses it.
 */
export const APP_BROWSER_SUBNET_DEFAULT = '10.212.0.0/24';
export const APP_BROWSER_SUBNET = `\${APP_BROWSER_SUBNET:-${APP_BROWSER_SUBNET_DEFAULT}}`;
/** .docker/compose.yml's `app-browser-link`: another default, so a local compose
 * project on a swarm host never overlaps the overlay. */
export const APP_BROWSER_COMPOSE_SUBNET_DEFAULT = '10.212.1.0/24';
export const APP_BROWSER_COMPOSE_SUBNET = `\${APP_BROWSER_SUBNET:-${APP_BROWSER_COMPOSE_SUBNET_DEFAULT}}`;

/** The router's command in the image: as node, three capabilities. */
export const APP_BROWSER_CMD = [
    'setpriv',
    '--reuid=node',
    '--regid=node',
    '--init-groups',
    '--inh-caps=-all,+setuid,+setgid,+kill',
    '--ambient-caps=-all,+setuid,+setgid,+kill',
    '--',
    'node',
    'dist/server/app-browser/main.js',
];

const healthcheck = {
    test: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${APP_BROWSER_PORT}/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`,
    ],
    interval: '30s',
    timeout: '5s',
    // The self-test launches Chromium first.
    start_period: '60s',
    retries: 3,
};

/** A swarm overlay that adds the app browser to the app's stack. */
export function appBrowserOverlay() {
    return {
        services: {
            app: {
                environment: {
                    APP_BROWSER_URL: `http://company-brain-app-browser:${APP_BROWSER_PORT}`,
                    APP_BROWSER_SECRET_FILE: `/run/secrets/${APP_BROWSER_SECRET_NAME}`,
                    APP_BROWSER_MAX: '${APP_BROWSER_MAX:-8}',
                    // The internal apps listener (CB-232): its port, and only
                    // connections from the app_browser network.
                    APPS_INTERNAL_PORT: String(APP_BROWSER_UPSTREAM_PORT),
                    APPS_INTERNAL_SUBNET: APP_BROWSER_SUBNET,
                },
                networks: {
                    app_browser: { aliases: [APP_BROWSER_UPSTREAM_ALIAS] },
                },
            },
            'app-browser': {
                image: 'company-brain-app-browser:${APP_BROWSER_IMAGE_TAG:?Set APP_BROWSER_IMAGE_TAG}',
                environment: {
                    NODE_ENV: 'production',
                    APP_BROWSER_HOST: '0.0.0.0',
                    APP_BROWSER_PORT: String(APP_BROWSER_PORT),
                    APP_BROWSER_SECRET_FILE: `/run/secrets/${APP_BROWSER_SECRET_NAME}`,
                    APP_BROWSER_UPSTREAM: `http://${APP_BROWSER_UPSTREAM_ALIAS}:${APP_BROWSER_UPSTREAM_PORT}`,
                    APP_BROWSER_MAX: '${APP_BROWSER_MAX:-8}',
                    APP_BROWSER_UID_BASE: String(APP_BROWSER_UID_BASE),
                },
                secrets: [
                    {
                        source: APP_BROWSER_SECRET_NAME,
                        target: APP_BROWSER_SECRET_NAME,
                        uid: '1000',
                        gid: '1000',
                        mode: 0o400,
                    },
                ],
                networks: {
                    app_browser: { aliases: ['company-brain-app-browser'] },
                },
                read_only: true,
                tmpfs: ['/tmp'],
                cap_drop: ['ALL'],
                cap_add: ['SETUID', 'SETGID', 'KILL'],
                security_opt: [
                    'no-new-privileges:true',
                    'seccomp=${APP_BROWSER_SECCOMP_PROFILE:?Set APP_BROWSER_SECCOMP_PROFILE}',
                ],
                healthcheck,
                deploy: {
                    replicas: 1,
                    placement: { constraints: ['node.labels.socio == true'] },
                    resources: { limits: { cpus: '2', memory: '4G' } },
                    update_config: { order: 'stop-first' },
                    restart_policy: { condition: 'any', delay: '5s' },
                },
            },
        },
        networks: {
            // The app and the app browser only. Internal: nothing reaches out.
            // A fixed subnet, so the app's listener can refuse every other source.
            app_browser: {
                driver: 'overlay',
                internal: true,
                attachable: false,
                ipam: { config: [{ subnet: APP_BROWSER_SUBNET }] },
            },
        },
        secrets: {
            [APP_BROWSER_SECRET_NAME]: { external: true, name: APP_BROWSER_SECRET_SWARM_NAME },
        },
    };
}

/** The local compose service (.docker/compose.yml, profile `app-browser`; paths resolve against .docker/). */
export function appBrowserComposeService() {
    return {
        profiles: ['app-browser'],
        build: { context: '..', target: 'app-browser' },
        environment: {
            APP_BROWSER_SECRET: '${APP_BROWSER_SECRET:-}',
            APP_BROWSER_UPSTREAM: `http://app:${APP_BROWSER_UPSTREAM_PORT}`,
        },
        networks: ['app-browser-link'],
        init: true,
        restart: 'unless-stopped',
        read_only: true,
        tmpfs: ['/tmp:size=512m'],
        security_opt: ['no-new-privileges:true', 'seccomp=../deployment/app-browser/seccomp.json'],
        cap_drop: ['ALL'],
        cap_add: ['SETUID', 'SETGID', 'KILL'],
    };
}

/** .docker/compose.yml's network shared by the app and the app browser alone. */
export function appBrowserComposeNetwork() {
    return {
        internal: true,
        ipam: { config: [{ subnet: APP_BROWSER_COMPOSE_SUBNET }] },
    };
}

/** What .docker/compose.yml's `app` sets for the internal apps listener. */
export function appBrowserComposeAppEnvironment() {
    return {
        APPS_INTERNAL_PORT: String(APP_BROWSER_UPSTREAM_PORT),
        APPS_INTERNAL_SUBNET: APP_BROWSER_COMPOSE_SUBNET,
    };
}

/**
 * Syscalls the profile refuses: the kernel attack surface Docker's
 * default profile refuses that a process without capabilities could
 * otherwise reach, and debugging of other processes. Everything else is
 * allowed, notably clone/unshare with namespace flags and chroot, which
 * Chromium's namespace sandbox needs and Docker's default refuses
 * without CAP_SYS_ADMIN (the capability this replaces).
 */
export const SECCOMP_DENIED = [
    'acct',
    'add_key',
    'bpf',
    'clock_adjtime',
    'clock_settime',
    'delete_module',
    'fanotify_init',
    'finit_module',
    'fsconfig',
    'fsmount',
    'fsopen',
    'fspick',
    'init_module',
    'io_uring_enter',
    'io_uring_register',
    'io_uring_setup',
    'ioperm',
    'iopl',
    'kcmp',
    'kexec_file_load',
    'kexec_load',
    'keyctl',
    'lookup_dcookie',
    'mount',
    'mount_setattr',
    'move_mount',
    'name_to_handle_at',
    'nfsservctl',
    'open_by_handle_at',
    'open_tree',
    'perf_event_open',
    'pivot_root',
    'process_vm_readv',
    'process_vm_writev',
    'ptrace',
    'quotactl',
    'quotactl_fd',
    'reboot',
    'request_key',
    'settimeofday',
    'swapoff',
    'swapon',
    'syslog',
    'umount2',
    'uselib',
    'userfaultfd',
    'vm86',
    'vm86old',
] as const;

/** The seccomp profile (deployment/app-browser/seccomp.json). */
export function chromiumSeccompProfile() {
    return {
        defaultAction: 'SCMP_ACT_ALLOW',
        architectures: ['SCMP_ARCH_X86_64', 'SCMP_ARCH_X86', 'SCMP_ARCH_X32', 'SCMP_ARCH_AARCH64', 'SCMP_ARCH_ARM'],
        syscalls: [
            {
                names: [...SECCOMP_DENIED],
                action: 'SCMP_ACT_ERRNO',
                errnoRet: 1,
            },
        ],
    };
}
