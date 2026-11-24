/**
 * The domains module: hostnames the workspace provisions on demand through
 * Nginx Proxy Manager (proxy hosts, Let's Encrypt certificates by DNS-01)
 * and Cloudflare DNS (A records, DNS only). Operators only.
 */

export type DomainOpKind = 'ensure_base' | 'provision' | 'remove';
export type DomainOpStatus = 'running' | 'ok' | 'failed';
export type DomainStepAction = 'created' | 'updated' | 'kept' | 'deleted' | 'renewed' | 'skipped';

/** One change (or check) of an operation, as audited. */
export interface DomainStep {
    /** `dns`, `certificate` or `proxy_host`. */
    item: 'dns' | 'certificate' | 'proxy_host';
    /** The hostname or hostnames it is about. */
    name: string;
    action: DomainStepAction;
    /** What changed or why it was skipped; never a secret. */
    detail?: string;
}

/** A row of `domain_ops`: who asked for what, and how it went. */
export interface DomainOp {
    id: string;
    kind: DomainOpKind;
    /** The hostname for provision and remove; the base for ensure_base. */
    hostname: string;
    /** The operator's user id, or `app:<id>` for the apps hook. */
    actor: string;
    status: DomainOpStatus;
    steps: DomainStep[];
    error?: string;
    startedAt: number;
    finishedAt?: number;
}

/** A certificate as the Platform page shows it. */
export interface DomainCertificate {
    id: number;
    domains: string[];
    /** ISO time; undefined until NPM has issued it. */
    expiresOn?: string;
}

/** A hostname this module manages: the base pair or a provisioned one. */
export interface ManagedHostname {
    hostname: string;
    kind: 'base' | 'custom';
    /** The A record's address at the last operation (DNS is checked only then). */
    dnsContent?: string;
    /** NPM's proxy host for it, live; undefined when missing. */
    proxyHostId?: number;
    /** Whether the live proxy host matches what this module sets. */
    proxyHostOk: boolean;
    certificate?: DomainCertificate;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
}

/** `GET /api/domains` (operators). */
export interface DomainsStatus {
    /** Configured: NPM and Cloudflare settings are all there. */
    enabled: boolean;
    /** The settings that are missing (or `none`) when it's off. */
    missing: string[];
    settings?: {
        zone: string;
        base: string;
        targetIp: string;
        upstream: string;
        npmApiUrl: string;
        /** Whether DOMAINS_ACME_EMAIL is set (the address isn't shown). */
        acmeEmail: boolean;
    };
    /** The base setup: both hostnames, one certificate, both proxy hosts. */
    base?: {
        ok: boolean;
        hostnames: ManagedHostname[];
        certificate?: DomainCertificate;
    };
    /** Hostnames provisioned on their own (outside the wildcard). */
    hosts: ManagedHostname[];
    running?: DomainOp;
    ops: DomainOp[];
    /** Why the live check of NPM failed, if it did (redacted). */
    error?: string;
}

/** `POST /api/domains/base`, `POST /api/domains/hosts`, `DELETE …`: 202. */
export interface DomainOpStarted {
    op: DomainOp;
}
