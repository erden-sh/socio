import { randomUUID } from 'node:crypto';

import type {
    DomainCertificate,
    DomainOp,
    DomainOpKind,
    DomainsStatus,
    DomainStep,
    ManagedHostname,
} from '@socio/shared/domains';

import { CloudflareClient, RECORD_COMMENT } from './cloudflare-client.js';
import {
    DomainsError,
    type DomainsSettings,
    type DomainsSetup,
    type DomainsShape,
    type ProvisionResult,
} from './contract.js';
import { Redactor } from './http.js';
import {
    NpmClient,
    sameDomains,
    type NpmCertificate,
    type NpmProxyHost,
    type NpmProxyHostInput,
} from './npm-client.js';
import { domainsSettingsFromEnv, normalHostname, wildcardOf } from './settings.js';
import type { DomainHostRow, DomainsStore } from './store.js';

export interface DomainsServiceOptions {
    /** `domainsSettingsFromEnv`; off (everything missing) when unset. */
    config?: DomainsSetup;
    log?: (line: string) => void;
    /** Tests: the fetch both clients use. */
    transport?: typeof fetch;
    /** The service's clock (token expiry, certificates); the store keeps its own. */
    now?: () => number;
}

/** Proxy host fields this module sets and checks for drift. */
const CHECKED = [
    'forward_scheme',
    'forward_host',
    'forward_port',
    'certificate_id',
    'ssl_forced',
    'http2_support',
    'hsts_enabled',
    'block_exploits',
    'allow_websocket_upgrade',
    'caching_enabled',
    'enabled',
] as const;

const lower = (names: readonly string[]) => names.map((n) => n.toLowerCase());
const expired = (cert: NpmCertificate, now: number) => !!cert.expires_on && Date.parse(cert.expires_on) <= now;
const certificateView = (cert: NpmCertificate): DomainCertificate => ({
    id: cert.id,
    domains: cert.domain_names,
    ...(cert.expires_on ? { expiresOn: cert.expires_on } : {}),
});

/**
 * Provisions hostnames through Nginx Proxy Manager (as the workspace's
 * scoped NPM user) and Cloudflare DNS (one zone). One operation at a time;
 * each is idempotent (it reuses what exists by domain and fixes drift) and
 * audited in `domain_ops`. Routes are operators only; promoted apps that
 * want a custom domain will call `platform.domains.provision(hostname)`.
 *
 * Nothing about any user goes to NPM or Cloudflare: hostnames, the target
 * address, the upstream and the module's own credentials. Let's Encrypt
 * registers the NPM user's address, which must be DOMAINS_ACME_EMAIL.
 */
export class DomainsService implements DomainsShape {
    readonly store: DomainsStore;
    readonly settings?: DomainsSettings;
    readonly missing: readonly string[];
    readonly redactor = new Redactor();
    readonly npm?: NpmClient;
    readonly cloudflare?: CloudflareClient;
    private running?: { id: string; op?: DomainOp; done: Promise<DomainOp> };
    private log: (line: string) => void;
    private now: () => number;

    /** `store` is built on the workspace connection (`domains/layer.ts`, `composition/domains.ts`). */
    constructor(store: DomainsStore, options: DomainsServiceOptions = {}) {
        const config = options.config ?? domainsSettingsFromEnv({});
        this.now = options.now ?? Date.now;
        this.store = store;
        this.settings = config.settings;
        this.missing = config.missing;
        const log = options.log ?? ((line: string) => console.log(line));
        this.log = (line) => log(this.redactor.redact(line));
        const transport = options.transport ?? ((...args) => fetch(...args));
        if (this.settings) {
            this.npm = new NpmClient(this.settings.npm, this.redactor, transport, this.now);
            this.cloudflare = new CloudflareClient(
                this.settings.cloudflare,
                this.settings.zone,
                this.redactor,
                transport,
            );
        }
    }

    get enabled() {
        return !!this.settings;
    }

    /** The base pair: `DOMAINS_BASE` and `*.DOMAINS_BASE`. */
    baseNames() {
        const base = this.require().base;
        return [base, wildcardOf(base)];
    }

    private require() {
        if (!this.settings) {
            throw new DomainsError('not_configured', `Domains are off: set ${this.missing.join(', ')}.`);
        }
        return this.settings;
    }

    /**
     * A hostname `provision` accepts: under the zone, not the base, not one
     * label under it (the wildcard covers those), no wildcards.
     */
    checkHostname(raw: string) {
        const settings = this.require();
        const hostname = normalHostname(raw);
        if (!hostname) {
            throw new DomainsError(
                'invalid_hostname',
                'Enter a host name such as shop.example.com (letters, digits, dashes).',
            );
        }
        if (!hostname.endsWith(`.${settings.zone}`)) {
            throw new DomainsError('outside_zone', `Only host names under ${settings.zone} can be provisioned.`);
        }
        if (hostname === settings.base) {
            throw new DomainsError('covered', `${hostname} is the base: use “Set up domains”.`);
        }
        const under = hostname.endsWith(`.${settings.base}`) ? hostname.slice(0, -settings.base.length - 1) : undefined;
        if (under && !under.includes('.')) {
            throw new DomainsError('covered', `${hostname} is already covered by ${wildcardOf(settings.base)}.`);
        }
        return hostname;
    }

    /** The operation in progress, if any, once it is saved. */
    get current() {
        return this.running?.op;
    }
    /** Resolves when nothing is running. */
    async idle() {
        await this.running?.done.catch(() => undefined);
    }

    /**
     * Starts an operation. Refusals known at once (off, a bad hostname,
     * another operation running) throw; everything else is audited and ends
     * in the op's status.
     */
    private async begin(
        kind: DomainOpKind,
        hostname: string,
        actor: string,
        work: (steps: DomainStep[], save: () => Promise<void>) => Promise<void>,
    ) {
        if (this.running) {
            throw new DomainsError('busy', 'Another domain operation is running; try again when it ends.');
        }
        // Taken before the op is saved, so a second request is refused.
        const id = randomUUID();
        const started = this.store.startOp(kind, hostname, actor, id);
        const steps: DomainStep[] = [];
        const save = () => this.store.saveSteps(id, steps);
        const done = (async () => {
            const op = await started;
            let error: string | undefined;
            try {
                await work(steps, save);
            } catch (cause) {
                error = this.redactor.redact(cause instanceof Error ? cause.message : 'The operation failed.');
            }
            const finished = await this.store.finishOp(op.id, steps, error);
            const counts = (['created', 'updated', 'renewed', 'deleted'] as const)
                .map((action) => {
                    const n = steps.filter((step) => step.action === action).length;
                    return n ? `${n} ${action}` : '';
                })
                .filter(Boolean)
                .join(', ');
            this.log(
                `Domains: ${kind} ${hostname} ${finished.status}${counts ? ` (${counts})` : ''} by ${actor}${error ? `: ${error}` : ''}`,
            );
            return finished;
        })().finally(() => {
            if (this.running?.id === id) {
                this.running = undefined;
            }
        });
        this.running = { id, done };
        const op = await started.catch((error: unknown) => {
            // `done` fails the same way; the caller gets it here.
            done.catch(() => undefined);
            throw error;
        });
        if (this.running?.id === id) {
            this.running.op = op;
        }
        return { op, done };
    }

    /** `ensureBase` without waiting: the route answers 202 with the op. */
    async startEnsureBase(actor: string) {
        const settings = this.require();
        return this.begin('ensure_base', settings.base, actor, (steps, save) =>
            this.ensureBaseWork(actor, steps, save),
        );
    }
    /**
     * A records for the base and its wildcard to the target address, one
     * certificate for both (DNS-01), a proxy host for each forwarding to the
     * upstream. Reuses what exists and fixes drift; safe to run again.
     */
    async ensureBase(actor: string) {
        return (await this.startEnsureBase(actor)).done;
    }

    async startProvision(raw: string, actor: string) {
        const hostname = this.checkHostname(raw);
        return {
            hostname,
            ...(await this.begin('provision', hostname, actor, (steps, save) =>
                this.provisionWork(hostname, actor, steps, save),
            )),
        };
    }
    /**
     * A record, certificate and proxy host for one hostname under the zone
     * that the wildcard doesn't cover. Throws a `DomainsError` for hostnames
     * it refuses (outside the zone, covered, invalid) or while another
     * operation runs; otherwise resolves with the audited op (ok or failed)
     * and the hostname's state. The hook for promoted apps' custom domains.
     */
    async provision(raw: string, options: { actor: string } = { actor: 'system' }): Promise<ProvisionResult> {
        const { hostname, done } = await this.startProvision(raw, options.actor);
        const op = await done;
        const status = await this.status();
        return { op, host: status.hosts.find((h) => h.hostname === hostname) };
    }

    async startRemove(raw: string, actor: string) {
        this.require();
        const hostname = normalHostname(raw);
        const row = hostname ? await this.store.host(hostname) : undefined;
        if (!hostname || !row || row.kind !== 'custom') {
            throw new DomainsError('not_managed', 'Only host names this module provisioned can be removed.');
        }
        return this.begin('remove', hostname, actor, (steps, save) => this.removeWork(row, steps, save));
    }
    /** Removes a provisioned hostname: only the items this module created. */
    async remove(raw: string, actor: string) {
        return (await this.startRemove(raw, actor)).done;
    }

    // The operations.

    /**
     * Let's Encrypt registers the NPM user's email address (NPM 2.14 takes
     * none in the request): refuse unless DOMAINS_ACME_EMAIL is set and is
     * that address, so it is never anyone's personal one by accident.
     */
    private async certificateAllowed() {
        const settings = this.require();
        if (!settings.acmeEmail) {
            throw new DomainsError(
                'acme_email_missing',
                'DOMAINS_ACME_EMAIL is not set: refusing to request a certificate. Set it to the address the Let’s Encrypt account should use (the NPM user’s).',
            );
        }
        const me = await this.npm!.me();
        if (me.email?.trim().toLowerCase() !== settings.acmeEmail.toLowerCase()) {
            throw new DomainsError(
                'acme_email_mismatch',
                'The NPM user’s email address is not DOMAINS_ACME_EMAIL, and Let’s Encrypt would register it: refusing to request a certificate. Give the NPM user that address.',
            );
        }
    }

    private async ensureRecord(name: string, kind: 'base' | 'custom', actor: string, steps: DomainStep[]) {
        const settings = this.require();
        const cf = this.cloudflare!;
        const records = await cf.records(name);
        const blocking = records.find((record) => record.type === 'CNAME');
        if (blocking) {
            throw new DomainsError(
                'conflict',
                `${name} has a CNAME record; remove it in Cloudflare first.`,
                'cloudflare',
            );
        }
        const row = await this.store.host(name);
        const ours = (id: string, comment?: string | null) => comment === RECORD_COMMENT || id === row?.dnsRecordId;
        const a = records.filter((record) => record.type === 'A');
        if (!a.length) {
            const created = await cf.createA(name, settings.targetIp);
            await this.store.saveHost(name, kind, actor, {
                dnsRecordId: created.id,
                dnsContent: settings.targetIp,
                dnsCreated: 1,
            });
            steps.push({
                item: 'dns',
                name,
                action: 'created',
                detail: `A ${settings.targetIp}, DNS only`,
            });
            return;
        }
        const match = a.find((record) => record.content === settings.targetIp);
        if (
            kind === 'custom' &&
            a.some((record) => record.content !== settings.targetIp && !ours(record.id, record.comment))
        ) {
            throw new DomainsError(
                'conflict',
                `${name} already has an A record this module didn't create; not changing it.`,
                'cloudflare',
            );
        }
        const keep = match ?? a[0];
        let action: DomainStep['action'] = 'kept';
        const fixes: string[] = [];
        if (keep.content !== settings.targetIp) {
            fixes.push(`address ${keep.content} → ${settings.targetIp}`);
        }
        if (keep.proxied) {
            fixes.push('proxied → DNS only');
        }
        if (fixes.length) {
            await cf.updateA(keep.id, name, settings.targetIp);
            action = 'updated';
        }
        for (const extra of a.filter((record) => record.id !== keep.id)) {
            await cf.delete(extra.id);
            fixes.push(`extra A ${extra.content} deleted`);
            action = 'updated';
        }
        await this.store.saveHost(name, kind, actor, {
            dnsRecordId: keep.id,
            dnsContent: settings.targetIp,
            // Created by this module: recorded so, or carrying its comment.
            dnsCreated: row?.dnsRecordId === keep.id ? row.dnsCreated : keep.comment === RECORD_COMMENT ? 1 : 0,
        });
        steps.push({
            item: 'dns',
            name,
            action,
            ...(fixes.length ? { detail: fixes.join('; ') } : {}),
        });
    }

    /** The certificate for exactly these names: reused, renewed when expired, or requested. */
    private async ensureCertificate(names: string[], existing: NpmCertificate | undefined, steps: DomainStep[]) {
        const settings = this.require();
        const label = names.join(', ');
        if (!existing) {
            const created = await this.npm!.createCertificate(names, settings.cloudflare.token);
            steps.push({
                item: 'certificate',
                name: label,
                action: 'created',
                detail: "Let's Encrypt, DNS-01 (Cloudflare)",
            });
            return { cert: created, created: true };
        }
        if (expired(existing, this.now())) {
            await this.certificateAllowed();
            const renewed = await this.npm!.renewCertificate(existing.id);
            steps.push({ item: 'certificate', name: label, action: 'renewed' });
            return { cert: { ...existing, ...renewed }, created: false };
        }
        steps.push({
            item: 'certificate',
            name: label,
            action: 'kept',
            ...(existing.expires_on ? { detail: `expires ${existing.expires_on}` } : {}),
        });
        return { cert: existing, created: false };
    }

    private async saveCertificate(
        name: string,
        kind: 'base' | 'custom',
        actor: string,
        result: { cert: NpmCertificate; created: boolean },
    ) {
        const row = await this.store.host(name);
        await this.store.saveHost(name, kind, actor, {
            certificateId: result.cert.id,
            certificateCreated: result.created ? 1 : row?.certificateId === result.cert.id ? row.certificateCreated : 0,
        });
    }

    private proxyInput(name: string, certificateId: number): NpmProxyHostInput {
        const { upstream } = this.require();
        return {
            domain_names: [name],
            forward_scheme: upstream.scheme,
            forward_host: upstream.host,
            forward_port: upstream.port,
            certificate_id: certificateId,
            ssl_forced: true,
            http2_support: true,
            hsts_enabled: true,
            hsts_subdomains: false,
            block_exploits: true,
            allow_websocket_upgrade: true,
            caching_enabled: false,
            enabled: true,
        };
    }

    /** How a live proxy host differs from what this module sets. */
    private drift(host: NpmProxyHost, desired: NpmProxyHostInput) {
        const out: string[] = [];
        if (!sameDomains(host.domain_names, desired.domain_names)) {
            out.push('domain_names');
        }
        for (const field of CHECKED) {
            const live = host[field];
            const want = desired[field];
            if (typeof want === 'boolean' ? !!live !== want : live !== want) {
                out.push(field);
            }
        }
        return out;
    }

    private async ensureProxyHost(
        name: string,
        kind: 'base' | 'custom',
        certificateId: number,
        hosts: NpmProxyHost[],
        actor: string,
        steps: DomainStep[],
    ) {
        const desired = this.proxyInput(name, certificateId);
        const existing = hosts.find((host) => lower(host.domain_names).includes(name));
        if (!existing) {
            const created = await this.npm!.createProxyHost({
                ...desired,
                access_list_id: 0,
                advanced_config: '',
                locations: [],
                meta: {},
            });
            await this.store.saveHost(name, kind, actor, {
                proxyHostId: created.id,
                proxyHostCreated: 1,
            });
            steps.push({
                item: 'proxy_host',
                name,
                action: 'created',
                detail: `→ ${desired.forward_scheme}://${desired.forward_host}:${desired.forward_port}`,
            });
            return;
        }
        const drift = this.drift(existing, desired);
        if (drift.length) {
            await this.npm!.updateProxyHost(existing.id, desired);
        }
        const row = await this.store.host(name);
        await this.store.saveHost(name, kind, actor, {
            proxyHostId: existing.id,
            proxyHostCreated: row?.proxyHostId === existing.id ? row.proxyHostCreated : 0,
        });
        steps.push({
            item: 'proxy_host',
            name,
            action: drift.length ? 'updated' : 'kept',
            ...(drift.length ? { detail: `fixed ${drift.join(', ')}` } : {}),
        });
    }

    private async ensureBaseWork(actor: string, steps: DomainStep[], save: () => Promise<void>) {
        const names = this.baseNames();
        const npm = this.npm!;
        // Before any change: a certificate request must be allowed.
        let cert = (await npm.certificates()).find(
            (c) => c.provider === 'letsencrypt' && sameDomains(c.domain_names, names),
        );
        if (!cert) {
            await this.certificateAllowed();
        }
        for (const name of names) {
            await this.ensureRecord(name, 'base', actor, steps);
            await save();
        }
        const result = await this.ensureCertificate(names, cert, steps);
        cert = result.cert;
        for (const name of names) {
            await this.saveCertificate(name, 'base', actor, result);
        }
        await save();
        const hosts = await npm.proxyHosts();
        for (const name of names) {
            await this.ensureProxyHost(name, 'base', cert.id, hosts, actor, steps);
            await save();
        }
    }

    private async provisionWork(hostname: string, actor: string, steps: DomainStep[], save: () => Promise<void>) {
        const npm = this.npm!;
        let cert = (await npm.certificates()).find(
            (c) => c.provider === 'letsencrypt' && sameDomains(c.domain_names, [hostname]),
        );
        if (!cert) {
            await this.certificateAllowed();
        }
        await this.ensureRecord(hostname, 'custom', actor, steps);
        await save();
        const result = await this.ensureCertificate([hostname], cert, steps);
        cert = result.cert;
        await this.saveCertificate(hostname, 'custom', actor, result);
        await save();
        await this.ensureProxyHost(hostname, 'custom', cert.id, await npm.proxyHosts(), actor, steps);
    }

    private async removeWork(row: DomainHostRow, steps: DomainStep[], save: () => Promise<void>) {
        const npm = this.npm!;
        const name = row.hostname;
        const hosts = await npm.proxyHosts();
        const host = row.proxyHostId ? hosts.find((entry) => entry.id === row.proxyHostId) : undefined;
        if (host && row.proxyHostCreated) {
            await npm.deleteProxyHost(host.id);
            steps.push({ item: 'proxy_host', name, action: 'deleted' });
        } else {
            steps.push({
                item: 'proxy_host',
                name,
                action: 'skipped',
                detail: host ? 'not created by this module' : 'already gone',
            });
        }
        await save();
        if (row.certificateId) {
            const cert = (await npm.certificates()).find((entry) => entry.id === row.certificateId);
            const inUse = hosts.some((entry) => entry.id !== host?.id && entry.certificate_id === row.certificateId);
            if (cert && row.certificateCreated && !inUse) {
                await npm.deleteCertificate(cert.id);
                steps.push({ item: 'certificate', name, action: 'deleted' });
            } else {
                steps.push({
                    item: 'certificate',
                    name,
                    action: 'skipped',
                    detail: !cert
                        ? 'already gone'
                        : inUse
                          ? 'used by another proxy host'
                          : 'not created by this module',
                });
            }
            await save();
        }
        if (row.dnsRecordId) {
            const record = (await this.cloudflare!.records(name)).find((entry) => entry.id === row.dnsRecordId);
            if (record && row.dnsCreated) {
                await this.cloudflare!.delete(record.id);
                steps.push({ item: 'dns', name, action: 'deleted' });
            } else {
                steps.push({
                    item: 'dns',
                    name,
                    action: 'skipped',
                    detail: record ? 'not created by this module' : 'already gone',
                });
            }
            await save();
        }
        await this.store.deleteHost(name);
    }

    // Status.

    /**
     * What exists: the hostnames this module manages with NPM's live state
     * (proxy hosts, certificates and their expiry) and the A record as of the
     * last operation (Cloudflare is called only by operations), and the
     * recent operations.
     */
    async status(): Promise<DomainsStatus> {
        const ops = await this.store.ops(20);
        const running = this.running ? await this.store.op(this.running.id) : undefined;
        if (!this.settings) {
            return {
                enabled: false,
                missing: [...this.missing],
                hosts: [],
                ops,
                ...(running ? { running } : {}),
            };
        }
        const settings = this.settings;
        let hosts: NpmProxyHost[] = [];
        let certs: NpmCertificate[] = [];
        let error: string | undefined;
        try {
            [hosts, certs] = await Promise.all([this.npm!.proxyHosts(), this.npm!.certificates()]);
        } catch (cause) {
            error = this.redactor.redact(cause instanceof Error ? cause.message : 'NPM could not be read.');
        }
        const view = (row: DomainHostRow): ManagedHostname => {
            const host = hosts.find((entry) => lower(entry.domain_names).includes(row.hostname));
            const cert = certs.find((entry) => entry.id === (host?.certificate_id ?? row.certificateId ?? -1));
            return {
                hostname: row.hostname,
                kind: row.kind,
                ...(row.dnsContent ? { dnsContent: row.dnsContent } : {}),
                ...(host ? { proxyHostId: host.id } : {}),
                proxyHostOk: !!host && !!cert && !this.drift(host, this.proxyInput(row.hostname, cert.id)).length,
                ...(cert ? { certificate: certificateView(cert) } : {}),
                createdBy: row.createdBy,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            };
        };
        const names = this.baseNames();
        const baseRows = (await Promise.all(names.map((name) => this.store.host(name)))).filter(
            (row): row is DomainHostRow => !!row,
        );
        const baseCert = certs.find((c) => c.provider === 'letsencrypt' && sameDomains(c.domain_names, names));
        const baseViews = baseRows.map(view);
        return {
            enabled: true,
            missing: [],
            settings: {
                zone: settings.zone,
                base: settings.base,
                targetIp: settings.targetIp,
                upstream: `${settings.upstream.scheme}://${settings.upstream.host}:${settings.upstream.port}`,
                npmApiUrl: settings.npm.url,
                acmeEmail: !!settings.acmeEmail,
            },
            base: {
                ok:
                    !error &&
                    baseViews.length === 2 &&
                    !!baseCert &&
                    !expired(baseCert, this.now()) &&
                    baseViews.every(
                        (entry) =>
                            entry.proxyHostOk &&
                            entry.dnsContent === settings.targetIp &&
                            entry.certificate?.id === baseCert.id,
                    ),
                hostnames: baseViews,
                ...(baseCert ? { certificate: certificateView(baseCert) } : {}),
            },
            hosts: (await this.store.hosts('custom')).map(view),
            ...(running ? { running } : {}),
            ops,
            ...(error ? { error } : {}),
        };
    }

    /** At start: an operation the last process didn't finish is marked failed. */
    recover() {
        return this.store.interruptRunning();
    }
}
