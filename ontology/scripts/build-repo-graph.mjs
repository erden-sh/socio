#!/usr/bin/env node
// Writes the generated part of Socio's knowledge graph. Deterministic: the
// same tree gives the same bytes. Standard library only.
//
//   node ontology/scripts/build-repo-graph.mjs     (pnpm ontology:graph)
//
// - ontology/data/repo.ttl: the workspace packages and apps, the server's
//   feature folders (their order, contracts, layers and the imports between
//   them) and the client's modules.
//   With them, the facts the checks Erden runs need: the tables that hold
//   personal data, their soft-delete columns and the code that deletes them.
// - ontology/audit/facts.ttl (not committed): cross-file facts for the
//   checks in ontology/queries/checks: the repository's files, and each place
//   a file mentions a path, an environment variable, a feature flag, an HTTP
//   route, an Effect tag, a table or another feature's module, with its line.
//   Too large for Erden's reasoner, so a SPARQL engine runs those checks
//   (ontology/README.md).
//
// Files are those git lists (tracked, and untracked but not ignored), read
// from the working tree. Nothing here records people: no git history,
// authors or emails.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';

const ROOT = posix.resolve(import.meta.dirname.split('\\').join('/'), '..', '..');
const SERVER = 'src/server';
/** What this script writes: left out of the files it reads, so a second run sees what the first did. */
const GENERATED = ['ontology/data/repo.ttl', 'ontology/audit/facts.ttl'];

/**
 * The domain concepts each server feature implements, kept by hand and only
 * where the feature clearly owns the concept. Keys are folder names of
 * src/server; values are local names in modules/domain.ttl.
 */
const FEATURE_CONCEPTS = {
    agents: ['ConnectedAgent'],
    apps: ['MiniApp'],
    approvals: ['ApprovalRequest'],
    coding: ['CodingSession'],
    computers: ['Computer'],
    cycles: ['WorkCycle'],
    dataspace: ['DataSpace', 'Dataset'],
    dots: ['Socio'],
    integrations: ['Integration'],
    issues: ['Issue'],
    media: ['MediaFile'],
    memory: ['Memory', 'Profile', 'Episode', 'SpaceMemory'],
    notifications: ['Notification'],
    pages: ['Page'],
    plugins: ['Plugin'],
    rooms: ['Room'],
    schedules: ['Schedule', 'Goal', 'Job'],
    'service-accounts': ['ServiceAccount'],
    souls: ['Soul'],
    spaces: ['Space'],
    telegram: ['TelegramLink'],
    turns: ['Turn'],
    workspace: ['Workspace', 'Person', 'PersonGroup', 'AuditEntry'],
};

/** The same, for folders of packages/client/src/modules. */
const CLIENT_MODULE_CONCEPTS = {
    approvals: ['ApprovalRequest'],
    apps: ['MiniApp'],
    chat: ['Chat'],
    coding: ['CodingSession'],
    computers: ['Computer'],
    dataspace: ['DataSpace', 'Dataset'],
    dots: ['Socio'],
    issues: ['Issue'],
    media: ['MediaFile'],
    memories: ['Memory', 'Profile'],
    pages: ['Page'],
    plugins: ['Plugin'],
    rooms: ['Room'],
    schedules: ['Schedule', 'Goal', 'Job'],
    spaces: ['Space'],
    telegram: ['TelegramLink'],
};

/**
 * The tables that hold each domain class that holds personal data (its
 * socio:personalDataCategory in modules/domain.ttl), kept by hand from the
 * stores' schemas.
 */
const CONCEPT_TABLES = {
    AuditEntry: ['workspace_audit'],
    CodingSession: ['coding_sessions', 'gateway_exchanges'],
    Conversation: ['thread_bindings'],
    DataSpace: ['data_files', 'data_datasets'],
    Episode: ['memory_episodes'],
    Integration: ['telegram_links', 'agent_grants', 'web_identity'],
    MediaFile: ['data_files', 'media_attachments'],
    Memory: ['memories'],
    Message: ['agent_runs', 'room_events'],
    Notification: ['notifications', 'notification_in_app'],
    Person: ['users'],
    Profile: ['user_profiles'],
    Turn: ['agent_runs'],
};

/**
 * The graph names no cloud provider: package descriptions that do are
 * rewritten in general terms, and anything left fails the build.
 */
const NEUTRAL_WORDING = [
    [/the APNs and FCM clients/g, 'the clients of the phone platforms\u2019 push services'],
    [/APNs and FCM/g, 'the phone platforms\u2019 push services'],
    [/Cloudflare Workers?/g, 'serverless worker'],
    [/for iOS and Android/g, 'for phones'],
];
const PROVIDER_NAMES = /\b(?:Cloudflare|AWS|Amazon|GCP|Google|Apple|Azure|APNs|FCM|iOS|Android)\b/i;

// ── Files ────────────────────────────────────────────────────────────────

const abs = (path) => posix.join(ROOT, path);
const isFile = (path) => existsSync(abs(path)) && statSync(abs(path)).isFile();
const read = (path) => readFileSync(abs(path), 'utf8');

/** Every file git knows of and doesn't ignore, sorted. */
const FILES = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
})
    .split('\0')
    .filter((path) => path && isFile(path) && !GENERATED.includes(path))
    .sort();
const FILE_SET = new Set(FILES);
const DIRS = new Set();
for (const file of FILES) {
    for (let dir = posix.dirname(file); dir !== '.'; dir = posix.dirname(dir)) {
        DIRS.add(dir);
    }
}
const PATHS = new Set([...FILE_SET, ...DIRS, ...GENERATED, 'ontology/audit']);
/** Files by name, for a bare Markdown file name that may mean any file of that name. */
const BASENAMES = new Map();
for (const file of FILES) {
    const name = posix.basename(file);
    (BASENAMES.get(name) ?? BASENAMES.set(name, []).get(name)).push(file);
}
const dirsIn = (path) =>
    [...DIRS]
        .filter((dir) => posix.dirname(dir) === path)
        .map((dir) => posix.basename(dir))
        .sort();

const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const isTest = (path) => /(?:^|\/)(?:tests?|__tests__|fixtures)\//.test(path) || /\.(?:test|spec)\.[^/]+$/.test(path);
/** Code that runs: not tests, not the vendored packages, not this generator. */
const isAppCode = (path) =>
    CODE.test(path) && !isTest(path) && !path.startsWith('vendor/') && !path.startsWith('ontology/');

function neutral(text) {
    let out = text;
    for (const [pattern, replacement] of NEUTRAL_WORDING) {
        out = out.replace(pattern, replacement);
    }
    if (PROVIDER_NAMES.test(out)) {
        throw new Error(`A description still names a provider; add a rewording to NEUTRAL_WORDING: ${out}`);
    }
    return out;
}

/** 1-based line of a character offset, by a sorted table of line starts. */
function lineIndex(text) {
    const starts = [0];
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
        starts.push(at + 1);
    }
    return (offset) => {
        let low = 0;
        let high = starts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (starts[mid] <= offset) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low + 1;
    };
}

/**
 * The comments of a JavaScript or TypeScript file, as `{ line, text }`, one
 * per comment line. A small scanner: strings and template literals are
 * skipped; a regular expression literal holding a quote can confuse it.
 */
function commentsOf(text) {
    const out = [];
    let line = 1;
    let at = 0;
    const push = (start, end, startLine) => {
        text.slice(start, end)
            .split('\n')
            .forEach((part, index) => out.push({ line: startLine + index, text: part }));
    };
    while (at < text.length) {
        const char = text[at];
        const next = text[at + 1];
        if (char === '\n') {
            line += 1;
            at += 1;
        } else if (char === '/' && next === '/') {
            const end = text.indexOf('\n', at) === -1 ? text.length : text.indexOf('\n', at);
            push(at + 2, end, line);
            at = end;
        } else if (char === '/' && next === '*') {
            const close = text.indexOf('*/', at + 2);
            const end = close === -1 ? text.length : close;
            push(at + 2, end, line);
            line += text.slice(at, end).split('\n').length - 1;
            at = end + 2;
        } else if (char === "'" || char === '"' || char === '`') {
            at += 1;
            while (at < text.length && text[at] !== char) {
                if (text[at] === '\\') {
                    at += 1;
                } else if (text[at] === '\n') {
                    line += 1;
                    if (char !== '`') {
                        break;
                    }
                }
                at += 1;
            }
            at += 1;
        } else {
            at += 1;
        }
    }
    return out;
}

/** Code with its comments blanked (lines kept), so a path in a comment isn't read as a call. */
function withoutComments(text) {
    const chars = [...text];
    let at = 0;
    const blank = (from, to) => {
        for (let i = from; i < to && i < chars.length; i += 1) {
            if (chars[i] !== '\n') {
                chars[i] = ' ';
            }
        }
    };
    while (at < text.length) {
        const char = text[at];
        if (char === '/' && text[at + 1] === '/') {
            const end = text.indexOf('\n', at) === -1 ? text.length : text.indexOf('\n', at);
            blank(at, end);
            at = end;
        } else if (char === '/' && text[at + 1] === '*') {
            const close = text.indexOf('*/', at + 2);
            const end = close === -1 ? text.length : close + 2;
            blank(at, end);
            at = end;
        } else if (char === "'" || char === '"' || char === '`') {
            at += 1;
            while (at < text.length && text[at] !== char && (char === '`' || text[at] !== '\n')) {
                at += text[at] === '\\' ? 2 : 1;
            }
            at += 1;
        } else {
            at += 1;
        }
    }
    return chars.join('');
}
const codeOf = new Map();
const code = (file) => codeOf.get(file) ?? codeOf.set(file, withoutComments(read(file))).get(file);

// ── Turtle ───────────────────────────────────────────────────────────────

const PREFIXES = [
    ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
    ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
    ['dcterms', 'http://purl.org/dc/terms/'],
    ['prov', 'http://www.w3.org/ns/prov#'],
    ['socio', 'https://socio.sh/ontology/'],
    ['sid', 'https://socio.sh/ontology/id/'],
];

const literal = (value) =>
    `"${String(value)
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '\\r')
        .replaceAll('\t', '\\t')}"`;
const integer = (value) => `"${value}"^^xsd:nonNegativeInteger`;
const positive = (value) => `"${value}"^^xsd:positiveInteger`;
const boolean = (value) => `"${value}"^^xsd:boolean`;
const slug = (text) =>
    text
        .toLowerCase()
        .replace(/^@/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
const id = (kind, name) => `sid:${kind}-${slug(name)}`;
const hash = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 20);
const fileIri = (path) => `<https://socio.sh/ontology/id/file/${path.split('/').map(encodeURIComponent).join('/')}>`;
const tokenIri = (kind, name) => `<https://socio.sh/ontology/id/${kind}/${encodeURIComponent(name)}>`;

class Graph {
    /** subject -> predicate -> Set of objects, all as Turtle text. */
    subjects = new Map();

    add(subject, predicate, object) {
        const predicates = this.subjects.get(subject) ?? this.subjects.set(subject, new Map()).get(subject);
        (predicates.get(predicate) ?? predicates.set(predicate, new Set()).get(predicate)).add(object);
    }

    /** `a` first, then the other predicates by name; subjects and objects sorted. */
    serialize(about) {
        const lines = [
            '# GENERATED by ontology/scripts/build-repo-graph.mjs (pnpm ontology:graph). Do not edit by hand.',
            `# ${about}`,
            ...PREFIXES.map(([prefix, iri]) => `@prefix ${prefix}: <${iri}> .`),
            '',
        ];
        const order = (a, b) => (a === 'a' ? -1 : b === 'a' ? 1 : a < b ? -1 : a > b ? 1 : 0);
        for (const subject of [...this.subjects.keys()].sort()) {
            const predicates = this.subjects.get(subject);
            const body = [...predicates.keys()]
                .sort(order)
                .map((predicate) => `    ${predicate} ${[...predicates.get(predicate)].sort().join(', ')}`);
            lines.push(`${subject}\n${body.join(' ;\n')} .`, '');
        }
        return `${lines.join('\n').trimEnd()}\n`;
    }

    get size() {
        let count = 0;
        for (const predicates of this.subjects.values()) {
            for (const objects of predicates.values()) {
                count += objects.size;
            }
        }
        return count;
    }
}

const repo = new Graph();
const facts = new Graph();

/** One mention: `kind` (a socio:MentionKind's local name) of `thing` in `file` at `line`. */
function mention(kind, thing, file, line, extra = {}) {
    const graph = extra.graph ?? facts;
    const subject = `sid:m-${hash(kind, thing, file, line, extra.writtenAs ?? '')}`;
    graph.add(subject, 'a', 'socio:Mention');
    graph.add(subject, 'socio:mentionKind', `socio:${kind}`);
    graph.add(subject, 'socio:mentionOf', thing);
    graph.add(subject, 'prov:wasDerivedFrom', fileIri(file));
    graph.add(subject, 'socio:sourceLine', positive(line));
    if (graph !== facts) {
        graph.add(fileIri(file), 'a', 'socio:RepoFile');
        graph.add(fileIri(file), 'socio:sourcePath', literal(file));
    }
    if (extra.writtenAs !== undefined) {
        graph.add(subject, 'socio:writtenAs', literal(extra.writtenAs));
    }
    if (extra.inComment !== undefined) {
        graph.add(subject, 'socio:inComment', boolean(extra.inComment));
    }
    for (const [predicate, values] of Object.entries(extra.more ?? {})) {
        for (const value of values) {
            graph.add(subject, predicate, value);
        }
    }
    return subject;
}

// ── Packages and apps ────────────────────────────────────────────────────

/** The `packages:` globs of pnpm-workspace.yaml: `'.'`, `'dir/*'` or `'dir/name'`. */
function workspaceMembers() {
    const members = [];
    let inPackages = false;
    for (const line of read('pnpm-workspace.yaml').split('\n')) {
        if (/^\S/.test(line)) {
            inPackages = line.startsWith('packages:');
            continue;
        }
        const match = inPackages && /^\s+-\s+['"]?([^'"#\s]+)['"]?/.exec(line);
        if (!match) {
            continue;
        }
        const pattern = match[1];
        if (pattern.endsWith('/*')) {
            const base = pattern.slice(0, -2);
            members.push(...dirsIn(base).map((name) => `${base}/${name}`));
        } else {
            members.push(pattern);
        }
    }
    return [...new Set(members)].filter((path) => isFile(posix.join(path, 'package.json'))).sort();
}

const packages = workspaceMembers().map((path) => ({ path, json: JSON.parse(read(posix.join(path, 'package.json'))) }));
const packageByName = new Map(packages.map((member) => [member.json.name, member]));
const rootPackage = packages.find((member) => member.path === '.');
/** Package folders, deepest first, for "the package a file is in". */
const packageDirs = packages
    .map((member) => member.path)
    .filter((path) => path !== '.')
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
const packageOf = (file) => packageDirs.find((dir) => file.startsWith(`${dir}/`)) ?? '.';

for (const { path, json } of packages) {
    const subject = id('package', json.name);
    repo.add(subject, 'a', 'socio:Package');
    if (path.startsWith('apps/')) {
        repo.add(subject, 'a', 'socio:App');
    }
    if (path.startsWith('vendor/')) {
        repo.add(subject, 'a', 'socio:VendoredPackage');
    }
    repo.add(subject, 'rdfs:label', literal(json.name));
    repo.add(subject, 'socio:packageName', literal(json.name));
    repo.add(subject, 'socio:sourcePath', literal(path));
    if (json.description) {
        repo.add(subject, 'dcterms:description', literal(neutral(json.description)));
    }
    const deps = { ...json.dependencies, ...json.devDependencies, ...json.peerDependencies };
    for (const name of Object.keys(deps)) {
        if (packageByName.has(name) && name !== json.name) {
            repo.add(subject, 'socio:dependsOn', id('package', name));
        }
    }
}

// ── Server features ──────────────────────────────────────────────────────

/** A `new Set([...])` or `[...]` of strings exported from the boundary guard. */
function guardList(name) {
    const text = read('scripts/check-feature-boundaries.mjs');
    const match = new RegExp(`export const ${name} = (?:new Set\\()?\\[([^\\]]*)\\]`).exec(text);
    if (!match) {
        throw new Error(`scripts/check-feature-boundaries.mjs: no ${name}`);
    }
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
const ENTRY_FILES = new Set(guardList('ENTRY_FILES'));
const ENTRY_PREFIXES = guardList('ENTRY_PREFIXES');
const isEntry = (file) => ENTRY_FILES.has(file) || ENTRY_PREFIXES.some((prefix) => file.startsWith(prefix));

const ranks = JSON.parse(read('scripts/feature-ranks.json')).order;
const baseline = JSON.parse(read('scripts/feature-boundary-baseline.json'));
const features = dirsIn(SERVER).filter((name) => name !== 'node_modules');
const SERVER_CODE = /\.(?:[cm]?ts|tsx)$/;
const serverFiles = FILES.filter((file) => file.startsWith(`${SERVER}/`) && SERVER_CODE.test(file));
const featureOfFile = (file) => {
    const rest = file.slice(SERVER.length + 1);
    return rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : undefined;
};

/** Relative module specifiers a file names: imports, re-exports and import() calls. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;

/** The file a relative specifier names, as TypeScript resolves `.js` to `.ts`. */
function resolveModule(from, specifier) {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
    const candidates = [
        base,
        `${stem}.ts`,
        `${stem}.tsx`,
        `${stem}.mts`,
        `${stem}.d.ts`,
        `${base}.ts`,
        `${base}/index.ts`,
    ];
    return candidates.find((path) => FILE_SET.has(path));
}

const featureDeps = new Map();
for (const file of serverFiles) {
    const feature = featureOfFile(file);
    const inServer = file.slice(SERVER.length + 1);
    if (feature) {
        facts.add(fileIri(file), 'socio:inFeature', id('feature', feature));
    }
    facts.add(fileIri(file), 'socio:isEntryFile', boolean(isEntry(inServer)));
    if (!feature || isEntry(inServer)) {
        continue;
    }
    const text = read(file);
    const lineOf = lineIndex(text);
    for (const match of text.matchAll(SPECIFIER)) {
        const target = resolveModule(file, match[1]);
        const other = target && target.startsWith(`${SERVER}/`) ? featureOfFile(target) : undefined;
        if (other && other !== feature) {
            (featureDeps.get(feature) ?? featureDeps.set(feature, new Set()).get(feature)).add(other);
            mention('Imports', fileIri(target), file, lineOf(match.index), { writtenAs: match[1] });
        }
    }
}

for (const feature of features) {
    const subject = id('feature', feature);
    const path = `${SERVER}/${feature}`;
    repo.add(subject, 'a', 'socio:ServerFeature');
    repo.add(subject, 'rdfs:label', literal(feature));
    repo.add(subject, 'socio:sourcePath', literal(path));
    repo.add(subject, 'socio:partOf', id('package', rootPackage.json.name));
    repo.add(subject, 'socio:hasLayer', boolean(FILE_SET.has(`${path}/layer.ts`)));
    if (ranks.includes(feature)) {
        repo.add(subject, 'socio:featureRank', integer(ranks.indexOf(feature)));
    }
    for (const concept of FEATURE_CONCEPTS[feature] ?? []) {
        repo.add(subject, 'socio:implementsConcept', `socio:${concept}`);
    }
    for (const other of featureDeps.get(feature) ?? []) {
        repo.add(subject, 'socio:dependsOn', id('feature', other));
    }
    if (FILE_SET.has(`${path}/contract.ts`)) {
        const contract = id('contract', feature);
        repo.add(contract, 'a', 'socio:Contract');
        repo.add(contract, 'rdfs:label', literal(`${feature}/contract.ts`));
        repo.add(contract, 'socio:sourcePath', literal(`${path}/contract.ts`));
        repo.add(contract, 'socio:partOf', subject);
    }
}

// Rule 1 exceptions the baseline records: `from -> to`, paths relative to src/server.
for (const entry of baseline.contractOnly) {
    const [from, to] = entry.split(' -> ').map((file) => file.split('/')[0]);
    if (features.includes(from) && features.includes(to)) {
        repo.add(id('feature', from), 'socio:boundaryException', id('feature', to));
    }
}

// ── Client modules ───────────────────────────────────────────────────────

const MODULES = 'packages/client/src/modules';
const client = packages.find((member) => member.path === 'packages/client');
if (client && DIRS.has(MODULES)) {
    for (const name of dirsIn(MODULES)) {
        const subject = id('client-module', name);
        repo.add(subject, 'a', 'socio:ClientModule');
        repo.add(subject, 'rdfs:label', literal(name));
        repo.add(subject, 'socio:sourcePath', literal(`${MODULES}/${name}`));
        repo.add(subject, 'socio:partOf', id('package', client.json.name));
        for (const concept of CLIENT_MODULE_CONCEPTS[name] ?? []) {
            repo.add(subject, 'socio:implementsConcept', `socio:${concept}`);
        }
    }
}

// ── Facts: the files ─────────────────────────────────────────────────────

for (const path of [...PATHS].sort()) {
    facts.add(fileIri(path), 'a', 'socio:RepoFile');
    facts.add(fileIri(path), 'socio:sourcePath', literal(path));
}

/** Markdown files, and each code file's comments, as `{ file, line, text, inComment }`. */
const MARKDOWN = FILES.filter((file) => /\.mdx?$/.test(file));
const PROSE = [];
for (const file of MARKDOWN) {
    let fenced = false;
    read(file)
        .split('\n')
        .forEach((text, index) => {
            if (/^\s*(?:```|~~~)/.test(text)) {
                fenced = !fenced;
            }
            PROSE.push({ file, line: index + 1, text, inComment: false, fenced });
        });
}
for (const file of FILES.filter((path) => CODE.test(path))) {
    for (const { line, text } of commentsOf(read(file))) {
        PROSE.push({ file, line, text, inComment: true, fenced: false });
    }
}

// ── Facts: path references ───────────────────────────────────────────────

const TOP_DIRS =
    'src|docs|packages|apps|scripts|tests|content|deployment|vendor|public|patches|marketing|ontology|\\.github|\\.docker';
/** Bare paths in prose: under a top-level folder, or any name ending in .md. */
const BARE_PATH = new RegExp(
    `(?<![\\w@/.$-])(?:(?:${TOP_DIRS})/[\\w.@/-]*[\\w/]|(?:\\.{1,2}/)?[\\w.-]+(?:/[\\w.-]+)*\\.md)(?![\\w/])`,
    'g',
);
const EXTENSION = /\.[A-Za-z0-9]{1,6}$/;

/** A path as written, cleaned, or undefined when it isn't one. */
function pathToken(raw) {
    const token = raw
        .trim()
        .replace(/[.,;:)]+$/, '')
        .replace(/#.*$/, '')
        .replace(/\?.*$/, '')
        .replace(/:\d+(?::\d+)?(?:-\d+)?$/, '');
    if (!token || /[\s*{}<>$|=,'"[\]()\\]|\.\.\.|:\/\/|^[@~/]|:/.test(token)) {
        return undefined;
    }
    const segments = token.split('/');
    const first = segments[0];
    if (first.includes('.') && !/^\.{1,2}$|^\.[a-z]/.test(first) && segments.length > 1) {
        return undefined; // a host name, `example.org/x`
    }
    if (segments.includes('node_modules') || segments.includes('dist')) {
        return undefined;
    }
    const last = segments.at(-1);
    if (token.endsWith('/') && segments.length > 2) {
        return token; // `name/` alone is a folder's role (`infra/`, `images/`), not a path
    }
    if (segments.length > 1 && EXTENSION.test(last)) {
        return token;
    }
    return segments.length === 1 && /^[\w.-]+\.mdx?$/.test(token) ? token : undefined;
}

/** The repository paths a path written in `file` may mean. */
function candidates(file, token, { link }) {
    const plain = token.replace(/\/$/, '').replace(/^\.\//, '');
    const bases = link
        ? [posix.dirname(file)]
        : ['.', posix.dirname(file), packageOf(file), posix.join(packageOf(file), 'src')];
    if (!link) {
        bases.push(SERVER); // code moved out of src/server still names its feature's files
    }
    if (!link && file.startsWith(`${SERVER}/`)) {
        const feature = featureOfFile(file);
        if (feature) {
            bases.push(`${SERVER}/${feature}`);
        }
    }
    if (!link) {
        bases.push('src');
        if (!plain.includes('/')) {
            bases.push('docs');
        }
    }
    // A relative path whose first folder is under none of the bases names no repo path (an
    // example path like `reports/q3/summary.md`, a path in another repository).
    const first = plain.split('/')[0];
    const anchored =
        !plain.includes('/') ||
        new RegExp(`^(?:${TOP_DIRS}|\\.{1,2})$`).test(first) ||
        bases.some((base) => DIRS.has(posix.normalize(posix.join(base, first))));
    if (!anchored) {
        return [];
    }
    const out = new Set();
    if (!plain.includes('/')) {
        for (const path of BASENAMES.get(plain) ?? []) {
            out.add(path);
        }
    }
    for (const base of bases) {
        const joined = posix.normalize(posix.join(base, plain));
        if (joined.startsWith('..') || posix.isAbsolute(joined)) {
            continue;
        }
        out.add(joined);
        if (/\.[cm]?js$/.test(joined)) {
            out.add(joined.replace(/\.([cm]?)js$/, '.$1ts'));
            out.add(joined.replace(/\.js$/, '.tsx'));
        }
    }
    return [...out].sort();
}

/**
 * Words that say where something was or came from, or what isn't there: the paths near
 * them (the line, the three before it, the one after) may be gone on purpose, or name
 * another repository's tree.
 */
const HISTORY_NOTE =
    /\b(?:moved|formerly|renamed|ported|adapted|based on|copied|mirrors?|upstream|used to|came from|replaces|replaced|was deleted|were deleted|removed|no longer|there is no|at commit|pinned version|T3 Code|t3code)\b|\(MIT\)|\bonce `|^\s*(?:\/\/|\*)?\s*From\b/i;
const proseLines = new Map();
for (const entry of PROSE) {
    (proseLines.get(entry.file) ?? proseLines.set(entry.file, new Map()).get(entry.file)).set(entry.line, entry.text);
}
/**
 * Whether a history word is near a line: in a comment, anywhere in its paragraph (up to a
 * blank comment line, at most 12 lines either way); in Markdown, on the line, the three
 * before it or the one after.
 */
const nearHistory = (file, line, inComment) => {
    const lines = proseLines.get(file);
    if (!inComment) {
        for (let at = line - 3; at <= line + 1; at += 1) {
            if (HISTORY_NOTE.test(lines.get(at) ?? '')) {
                return true;
            }
        }
        return false;
    }
    const blank = (at) =>
        !lines.has(at) ||
        !lines
            .get(at)
            .replace(/^[\s*/]*/, '')
            .trim();
    if (HISTORY_NOTE.test(lines.get(line))) {
        return true;
    }
    for (const step of [-1, 1]) {
        for (let at = line + step; Math.abs(at - line) <= 12 && !blank(at); at += step) {
            if (HISTORY_NOTE.test(lines.get(at))) {
                return true;
            }
        }
    }
    return false;
};
const references = [];
for (const { file, line, text, inComment } of PROSE) {
    if (file.startsWith('tests/fixtures/') || file.includes('/fixtures/')) {
        continue; // fixtures are data, not prose about this tree
    }
    const found = new Map();
    for (const match of text.matchAll(/`([^`]+)`/g)) {
        found.set(match[1], false);
    }
    if (!inComment) {
        for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
            if (!/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(match[1])) {
                found.set(match[1], true);
            }
        }
    }
    for (const match of text.replace(/`[^`]*`/g, ' ').matchAll(BARE_PATH)) {
        if (!found.has(match[0])) {
            found.set(match[0], false);
        }
    }
    for (const [raw, link] of found) {
        const token = pathToken(link ? decodeURIComponent(raw) : raw);
        if (!token) {
            continue;
        }
        const options = candidates(file, token, { link });
        if (!options.length) {
            continue;
        }
        references.push({
            file,
            line,
            token,
            inComment,
            options,
            history: nearHistory(file, line, inComment),
            historyLine: [line, line + 1].some((at) => HISTORY_NOTE.test(proseLines.get(file).get(at) ?? '')),
        });
    }
}
// Paths .gitignore covers (a native app's generated ios/, a build's output) exist only where
// they were built; a reference to one isn't dangling.
const unresolved = [
    ...new Set(references.flatMap(({ options }) => (options.some((p) => PATHS.has(p)) ? [] : options))),
];
const ignored = spawnSync('git', ['-C', ROOT, 'check-ignore', '--no-index', '--stdin'], {
    input: unresolved.join('\n'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
})
    .stdout.split('\n')
    .filter(Boolean);
for (const path of ignored.sort()) {
    facts.add(fileIri(path), 'a', 'socio:RepoFile');
    facts.add(fileIri(path), 'socio:sourcePath', literal(path));
    facts.add(fileIri(path), 'socio:gitIgnored', boolean(true));
}
for (const { file, line, token, inComment, options, history, historyLine } of references) {
    mention('References', tokenIri('path', token), file, line, {
        writtenAs: token,
        inComment,
        more: {
            'socio:candidatePath': options.map(literal),
            ...(history ? { 'socio:inHistoryNote': [boolean(true)] } : {}),
            ...(historyLine ? { 'socio:onHistoryLine': [boolean(true)] } : {}),
        },
    });
}

// ── Facts: environment variables ─────────────────────────────────────────

const ENV_NAME = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*';
const envIri = (name) => `sid:env-${name}`;
const envSeen = new Set();
/** Every env mention as `{ kind, name, file, line, writtenAs }`, for the composed names below. */
const envMentions = [];
function envMention(kind, name, file, line, writtenAs) {
    envSeen.add(name);
    envMentions.push({ kind, name, file, line, writtenAs });
    facts.add(envIri(name), 'a', 'socio:EnvVar');
    facts.add(envIri(name), 'rdfs:label', literal(name));
    mention(kind, envIri(name), file, line, writtenAs === undefined ? {} : { writtenAs });
}
const envTemplates = [];

// Declared: .env.example files, compose `environment:` entries, Dockerfile ENV and ARG, workers' [vars].
const DECLARED = new RegExp(`^\\s*#?\\s*(${ENV_NAME})=`);
for (const file of FILES.filter((path) => /(?:^|\/)\.env\.example$/.test(path))) {
    read(file)
        .split('\n')
        .forEach((text, index) => {
            const match = DECLARED.exec(text);
            if (match) {
                envMention('Declares', match[1], file, index + 1);
            }
        });
}
const SHELLISH = (path) =>
    /(?:^|\/)(?:compose[\w.-]*\.ya?ml|[\w.-]*\.?Dockerfile|wrangler\.toml)$/.test(path) || path.endsWith('.sh');
for (const file of FILES.filter(SHELLISH)) {
    const compose = /\.ya?ml$/.test(file);
    let inEnvironment = false;
    let indent = 0;
    let inVars = false;
    let inEnvLine = false;
    read(file)
        .split('\n')
        .forEach((text, index) => {
            const line = index + 1;
            if (compose) {
                const key = /^(\s*)environment:\s*$/.exec(text);
                if (key) {
                    inEnvironment = true;
                    indent = key[1].length;
                    return;
                }
                if (inEnvironment && text.trim() && /^(\s*)/.exec(text)[1].length <= indent) {
                    inEnvironment = false;
                }
                const entry = inEnvironment && new RegExp(`^\\s*(?:-\\s*)?['"]?(${ENV_NAME})(?:=|:\\s|:$)`).exec(text);
                if (entry) {
                    envMention('Declares', entry[1], file, line);
                }
            }
            if (file.endsWith('Dockerfile')) {
                // `ENV A=1 B=2 \` and its continuation lines; `ARG NAME[=default]`.
                const env = /^\s*ENV\s+(.*)$/.exec(text) ?? (inEnvLine ? [text, text] : null);
                if (env) {
                    for (const match of env[1].matchAll(new RegExp(`(?:^|\\s)(${ENV_NAME})=`, 'g'))) {
                        envMention('Declares', match[1], file, line);
                    }
                    const single = new RegExp(`^\\s*ENV\\s+(${ENV_NAME})\\s+[^=]`).exec(text);
                    if (single) {
                        envMention('Declares', single[1], file, line);
                    }
                }
                inEnvLine = (env !== null || inEnvLine) && /\\\s*$/.test(text);
                const arg = new RegExp(`^\\s*ARG\\s+(${ENV_NAME})(?:=|\\s|$)`).exec(text);
                if (arg) {
                    envMention('Declares', arg[1], file, line);
                }
            }
            if (file.endsWith('wrangler.toml')) {
                if (/^\s*\[/.test(text)) {
                    inVars = /^\s*\[(?:env\.[\w-]+\.)?vars\]/.test(text);
                }
                const entry = inVars && new RegExp(`^\\s*(${ENV_NAME})\\s*=`).exec(text);
                if (entry) {
                    envMention('Declares', entry[1], file, line);
                }
                // A binding (`binding = "DB"`) is what the worker reads as `env.DB`.
                const binding = new RegExp(`^\\s*binding\\s*=\\s*["'](${ENV_NAME})["']`).exec(text);
                if (binding) {
                    envMention('Declares', binding[1], file, line);
                }
            }
            if (!text.trimStart().startsWith('#')) {
                for (const match of text.matchAll(
                    new RegExp(`\\$\\{(${ENV_NAME})(?=[}:?\\-])|\\$(${ENV_NAME})\\b`, 'g'),
                )) {
                    envMention('Reads', match[1] ?? match[2], file, line);
                }
            }
        });
}

// Read: code that reads `env.X`, `env['X']`, `process.env.X`, and the setting names
// a file that reads the environment passes as plain strings (`env: 'X'`, `renamedSetting(env, 'X', 'Y')`).
const ENV_MEMBER = new RegExp(`\\b(?:process\\.env|[\\w$]*[eE]nv)\\s*(?:\\?\\.|\\.)\\s*(${ENV_NAME})\\b`, 'g');
const ENV_INDEX = new RegExp(
    `\\b(?:process\\.env|[\\w$]*[eE]nv)\\s*(?:\\?\\.)?\\[\\s*['"\`](${ENV_NAME})['"\`]\\s*\\]`,
    'g',
);
/** A setting's name as a spec or a rename helper passes it: `env: 'X'`, `renamedSetting(env, 'X', 'Y')`. */
const ENV_SPEC = new RegExp(
    `\\benv:\\s*['"](${ENV_NAME})['"]|\\brenamedSetting\\(\\s*\\w+\\s*,\\s*['"](${ENV_NAME})['"]\\s*,\\s*['"](${ENV_NAME})['"]`,
    'g',
);
const ENV_STRING = /['"`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)['"`]/g;
/** A name the code composes: a template of `${...}` and capitals (`${name}_DAILY`, `${prefix}S3_${setting}`). */
const ENV_TEMPLATE = /`((?:\$\{[^}`]+\}|[A-Z0-9_])+)`/g;
const templateIri = (pattern) => `sid:env-template-${hash(pattern)}`;
// Setting names kept in constants (`export const ROOMS_ENV = 'ROOMS_ENABLED'`), read as `env[ROOMS_ENV]`.
const envConstants = new Map();
for (const file of FILES.filter(isAppCode)) {
    for (const match of code(file).matchAll(new RegExp(`\\bexport const (\\w+)\\s*=\\s*['"](${ENV_NAME})['"]`, 'g'))) {
        envConstants.set(match[1], match[2]);
    }
}
const ENV_BY_CONSTANT = /\b(?:process\.env|[\w$]*[eE]nv)\s*(?:\?\.)?\[\s*([A-Z][A-Z0-9_]*)\s*\]/g;
// Tests count too: a knob only a test reads (`OPS_PERF=1`) is still read; the checks scope by path.
for (const file of FILES.filter(
    (path) => CODE.test(path) && !path.startsWith('vendor/') && !path.startsWith('ontology/'),
)) {
    const text = code(file);
    const lineOf = lineIndex(text);
    const seen = new Set();
    for (const match of text.matchAll(ENV_BY_CONSTANT)) {
        if (envConstants.has(match[1])) {
            envMention('Reads', envConstants.get(match[1]), file, lineOf(match.index));
        }
    }
    for (const pattern of [ENV_MEMBER, ENV_INDEX, ENV_SPEC]) {
        for (const match of text.matchAll(pattern)) {
            for (const name of match.slice(1).filter(Boolean)) {
                seen.add(`${name}:${lineOf(match.index)}`);
                envMention('Reads', name, file, lineOf(match.index));
            }
        }
    }
    if (!/\bprocess\.env\b|\benv\s*[:[.?]/.test(text)) {
        continue;
    }
    // What code sets for itself or a child process: `process.env.X = ...` (or deletes), and an env
    // object's keys (`{ SOCIO_HOST_CWD: dir }`).
    const SETS = new RegExp(
        `\\b(?:process\\.env|[\\w$]*[eE]nv)\\s*(?:\\.\\s*(${ENV_NAME})|\\[\\s*['"](${ENV_NAME})['"]\\s*\\])\\s*=(?!=)|^\\s*['"]?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]?\\s*:(?!:)`,
        'gm',
    );
    for (const match of text.matchAll(SETS)) {
        envMention('Declares', match[1] ?? match[2] ?? match[3], file, lineOf(match.index));
        if (match[3]) {
            envMention('Names', match[3], file, lineOf(match.index)); // a key may also map a setting it reads
        }
    }
    for (const match of text.matchAll(new RegExp(`\\bdelete\\s+process\\.env\\.(${ENV_NAME})`, 'g'))) {
        envMention('Declares', match[1], file, lineOf(match.index));
    }
    // In a file that reads the environment, a plain capitalized string may be a setting's
    // name, or the end of one the code composes (`get('CLIENT_ID')` of `${prefix}CLIENT_ID`).
    for (const match of text.matchAll(ENV_STRING)) {
        if (!seen.has(`${match[1]}:${lineOf(match.index)}`) && match[1].length > 2) {
            envMention('Names', match[1], file, lineOf(match.index));
        }
    }
    for (const match of text.matchAll(ENV_TEMPLATE)) {
        const parts = match[1].split(/(\$\{[^}]+\})/).filter(Boolean);
        if (!parts.some((part) => part.startsWith('${')) || !parts.some((part) => /^[A-Z0-9_]{3,}$/.test(part))) {
            continue;
        }
        const pattern = `^${parts.map((part) => (part.startsWith('${') ? '[A-Z0-9_]*' : part)).join('')}$`;
        facts.add(templateIri(pattern), 'a', 'socio:EnvNameTemplate');
        facts.add(templateIri(pattern), 'socio:namePattern', literal(pattern));
        mention('Names', templateIri(pattern), file, lineOf(match.index), { writtenAs: match[1] });
        envTemplates.push({ pattern: new RegExp(pattern), file, line: lineOf(match.index), writtenAs: match[1] });
    }
}

// Documented: a backticked name, or `NAME=` in a code block or inline, in Markdown.
// A bare backticked name counts only if something else declares or reads it.
const envDocs = [];
for (const { file, line, text, inComment, fenced } of PROSE) {
    if (inComment) {
        continue;
    }
    const assigned = fenced ? new RegExp(`^\\s*#?\\s*(?:export\\s+)?(${ENV_NAME})=`).exec(text) : null;
    if (assigned) {
        envDocs.push([assigned[1], file, line, true]);
    }
    for (const match of text.matchAll(new RegExp(`\`(${ENV_NAME})(=[^\`]*)?\``, 'g'))) {
        envDocs.push([match[1], file, line, match[2] !== undefined]);
    }
}
for (const [name, file, line, assigned] of envDocs) {
    if ((assigned && /_|^[A-Z]{3,}$/.test(name)) || envSeen.has(name)) {
        envMention('Documents', name, file, line);
    }
}

// Names the code composes, resolved against the names the tree mentions: a setting is named
// where a template matches it (`${name}_DAILY`), where a string names its end after a prefix
// (`get('CLIENT_ID')` of `${prefix}CLIENT_ID`), and, for the secret-file convention, X_FILE
// where X is read and X where X_FILE is declared.
{
    const names = [...envSeen].sort();
    const suffixes = new Map();
    for (const entry of envMentions.filter((one) => one.kind === 'Names')) {
        (suffixes.get(entry.name) ?? suffixes.set(entry.name, []).get(entry.name)).push(entry);
    }
    const reads = envMentions.filter((one) => one.kind === 'Reads');
    const declares = envMentions.filter((one) => one.kind === 'Declares');
    for (const name of names) {
        for (const template of envTemplates.filter((one) => one.pattern.test(name))) {
            envMention('Names', name, template.file, template.line, template.writtenAs);
        }
        const parts = name.split('_');
        for (let at = 1; at < parts.length; at += 1) {
            for (const entry of suffixes.get(parts.slice(at).join('_')) ?? []) {
                envMention('Names', name, entry.file, entry.line, entry.name);
            }
        }
        if (name.endsWith('_FILE')) {
            for (const entry of reads.filter((one) => one.name === name.slice(0, -5))) {
                envMention('Names', name, entry.file, entry.line, entry.name);
            }
        }
        for (const entry of declares.filter((one) => one.name === `${name}_FILE`)) {
            envMention('Declares', name, entry.file, entry.line, entry.name);
        }
    }
}

// ── Facts: feature flags ─────────────────────────────────────────────────

const FLAG_FILE = 'packages/shared/src/flags.ts';
const flagIri = (key) => `sid:flag-${key}`;
const flagKeys = new Set();
if (FILE_SET.has(FLAG_FILE)) {
    const text = read(FLAG_FILE);
    const lineOf = lineIndex(text);
    const start = text.indexOf('export const FLAGS');
    const titles = new Map();
    for (const match of text.slice(start).matchAll(/key:\s*'([a-z0-9-]+)',\s*\n\s*title:\s*'([^']+)'/g)) {
        const key = match[1];
        flagKeys.add(key);
        titles.set(key, match[2]);
        facts.add(flagIri(key), 'a', 'socio:FeatureFlag');
        facts.add(flagIri(key), 'rdfs:label', literal(key));
        facts.add(flagIri(key), 'dcterms:title', literal(match[2]));
        mention('Defines', flagIri(key), FLAG_FILE, lineOf(start + match.index));
    }
    // A flag's `tools` exist only while it is on: the flag service reads it through them.
    const blocks = [...text.slice(start).matchAll(/key:\s*'([a-z0-9-]+)'/g)];
    blocks.forEach((match, index) => {
        const from = start + match.index;
        const to = index + 1 < blocks.length ? start + blocks[index + 1].index : text.length;
        const tools = /\btools:\s*\[\s*'/.exec(text.slice(from, to));
        if (tools) {
            mention('Reads', flagIri(match[1]), FLAG_FILE, lineOf(from + tools.index));
        }
    });
    const FLAG_CALL = /\b(?:useFlag|enabled|requireFlag|isFlagOn|flagOn)\(\s*(?:[\w.]+\s*,\s*)?'([a-z][a-z0-9-]*)'/g;
    for (const file of FILES.filter((path) => isAppCode(path) && path !== FLAG_FILE)) {
        const source = code(file);
        const lineOfCode = lineIndex(source);
        for (const match of source.matchAll(FLAG_CALL)) {
            facts.add(flagIri(match[1]), 'a', 'socio:FeatureFlag');
            facts.add(flagIri(match[1]), 'rdfs:label', literal(match[1]));
            mention('Reads', flagIri(match[1]), file, lineOfCode(match.index));
        }
        for (const match of source.matchAll(/['"`]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)['"`]/g)) {
            if (flagKeys.has(match[1])) {
                mention('Reads', flagIri(match[1]), file, lineOfCode(match.index));
            }
        }
    }
    for (const { file, line, text: prose, inComment } of PROSE) {
        if (inComment) {
            continue;
        }
        for (const key of flagKeys) {
            if (prose.includes(`\`${key}\``) || prose.includes(`**${titles.get(key)}**`) || prose.includes(`${key}=`)) {
                mention('Documents', flagIri(key), file, line);
            }
        }
    }
}

// ── Facts: HTTP routes ───────────────────────────────────────────────────

/**
 * A route path's keys: parameters (`:id`, `${id}`, `<id>`, `{id}`) as {}, no query, hash,
 * trailing slash or trailing `*`/`…`; a `{a,b}` segment gives one key per choice.
 */
function routeKeys(path) {
    const clean = path
        .replace(/[?#].*$/, '')
        .replace(/(?:\/\*|\/…|…|\*)$/, '')
        .replace(/\/+$/, '');
    let keys = [''];
    for (const segment of clean.split('/').slice(1)) {
        const choices = /^\{([^}]*,[^}]*)\}$/.exec(segment)?.[1].split(',') ?? [
            /^:|^\{|\$\{|^<|^\[/.test(segment) ? '{}' : segment.replace(/\{[^}]*\}$/, ''),
        ];
        keys = keys.flatMap((key) => choices.map((choice) => `${key}/${choice}`));
    }
    return keys.map((key) => key || '/');
}
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A key as a regular expression: {} for any one segment, and with `open`, any path under it. */
const routePattern = (key, open) => `^${escapeRegex(key).replaceAll('\\{\\}', '[^/]+')}${open ? '(?:/.*)?' : ''}$`;
const isOpen = (path) => /(?:\*|…)$/.test(path.replace(/[?#].*$/, ''));
const routeIri = (key) => tokenIri('route', key);
function routeThing(key) {
    facts.add(routeIri(key), 'a', 'socio:Route');
    facts.add(routeIri(key), 'rdfs:label', literal(key));
    return routeIri(key);
}

// Mount prefixes: every literal `.route('/x', ...)` and `basePath('/x')`, alone and in pairs.
const mounts = new Set(['']);
const serverCode = FILES.filter((path) => path.startsWith(`${SERVER}/`) && isAppCode(path));
for (const file of serverCode) {
    for (const match of code(file).matchAll(/\.(?:route|basePath)\(\s*['"`](\/[^'"`]*)['"`]/g)) {
        mounts.add(match[1].replace(/\/+$/, ''));
    }
}
const prefixes = new Set();
for (const a of mounts) {
    for (const b of mounts) {
        prefixes.add(`${a}${b}`);
    }
}

// Route paths kept in constants (`export const LEAVE_WORKSPACE_PATH = '/api/account/leave'`),
// and the local aliases a router makes of them (`const tokensPath = X.replace(/^\/api/, '')`).
const pathConstants = new Map();
for (const file of FILES.filter(isAppCode)) {
    for (const match of code(file).matchAll(/\bexport const ([A-Z][A-Z0-9_]*)\s*=\s*['"`](\/[^'"`$]*)['"`]/g)) {
        pathConstants.set(match[1], match[2]);
    }
}
const REGISTER = /\.(get|post|put|patch|delete|all|options|head)\(\s*(['"`])(\/[^'"`$]*)\2/g;
const REGISTER_NAMED = /\.(get|post|put|patch|delete|all)\(\s*(?:([A-Za-z_]\w*)\s*,|`\$\{(\w+)\}([^`$]*)`)/g;
const createEndpoint = /\bcreateAuthEndpoint\(\s*['"](\/[^'"]+)['"]\s*,\s*\{\s*method:\s*['"](\w+)['"]/g;
const REGISTER_ON = /\.on\(\s*(\[[^\]]*\]|['"][A-Za-z]+['"])\s*,\s*(?:\[\s*)?(['"`])(\/[^'"`$]*)\2/g;
for (const file of serverCode) {
    const text = code(file);
    const lineOf = lineIndex(text);
    const local = new Map(pathConstants);
    for (const match of text.matchAll(/\bconst (\w+)\s*=\s*([A-Z][A-Z0-9_]*)\.replace\(\/\^\\\/api\/\s*,\s*''\)/g)) {
        if (pathConstants.has(match[2])) {
            local.set(match[1], pathConstants.get(match[2]).replace(/^\/api/, ''));
        }
    }
    const found = [
        ...[...text.matchAll(REGISTER)].map((m) => [m[1].toUpperCase(), m[3], m.index]),
        ...[...text.matchAll(REGISTER_ON)].map((m) => [m[1].replace(/[[\]'"\s]/g, '').toUpperCase(), m[3], m.index]),
        ...[...text.matchAll(REGISTER_NAMED)]
            .filter((m) => local.has(m[2] ?? m[3]))
            .map((m) => [m[1].toUpperCase(), `${local.get(m[2] ?? m[3])}${m[4] ?? ''}`, m.index]),
        // Better Auth's own endpoints, served under /api/auth.
        ...[...text.matchAll(createEndpoint)].map((m) => [m[2].toUpperCase(), `/api/auth${m[1]}`, m.index]),
    ];
    for (const [method, path, index] of found) {
        if (/\b404\b/.test(text.slice(index, text.indexOf('\n', index + 1)))) {
            continue; // a catch-all that answers 404 registers nothing
        }
        const keys = [...new Set([...prefixes].flatMap((prefix) => routeKeys(`${prefix}${path}`)))];
        mention('Registers', routeThing(routeKeys(path)[0]), file, lineOf(index), {
            writtenAs: path,
            more: {
                'socio:httpMethod': [literal(method)],
                'socio:routeKey': keys.map(literal),
                'socio:routePattern': keys.map((key) => literal(routePattern(key, isOpen(path)))),
            },
        });
    }
}

/** A route a client or a doc names, with its keys and patterns. */
function routeReference(kind, path, file, line, extra = {}) {
    const keys = routeKeys(path);
    mention(kind, routeThing(keys[0]), file, line, {
        ...extra,
        more: {
            ...extra.more,
            'socio:routeKey': keys.map(literal),
            'socio:routePattern': keys.map((key) => literal(routePattern(key, isOpen(path)))),
        },
    });
}

// Calls: the client's `/api/...` strings and templates (comments left out).
const CLIENT_DIRS = ['packages/client/src/', 'apps/mobile/src/', 'packages/plugin-ui/src/', 'packages/app-sdk/src/'];
for (const file of FILES.filter((path) => isAppCode(path) && CLIENT_DIRS.some((dir) => path.startsWith(dir)))) {
    const text = code(file);
    const lineOf = lineIndex(text);
    for (const match of text.matchAll(/(['"`])(\/api(?:\/[^'"`\s]*)?)/g)) {
        // A template's last `${...}` glued to a segment is its query or suffix (`history${query}`).
        const path = match[2].replace(/([^/])\$\{[^}]*\}?$/, '$1').replace(/\$\{[^}]*\}/g, '{}');
        if (/\{\}[^/]|[^/]\{\}/.test(path)) {
            continue; // a parameter inside a segment: not a path a key can name
        }
        routeReference('Calls', path, file, lineOf(match.index), { writtenAs: match[2] });
    }
}

// Documented: `/api/...` and `METHOD /api/...` in Markdown, outside the release notes' history,
// unless the line says the route answers 404 or is gone, or is about another service's API
// (the proxy manager's and the container manager's the setup guide drives).
const OTHER_SERVICE_API = /\bNPM\b|\bPortainer\b/;
for (const { file, line, text, inComment } of PROSE) {
    if (inComment || file === 'docs/RELEASE-NOTES.md' || /\b404\b/.test(text) || HISTORY_NOTE.test(text)) {
        continue;
    }
    if (OTHER_SERVICE_API.test(text)) {
        continue;
    }
    for (const match of text.matchAll(/`(?:(GET|POST|PUT|PATCH|DELETE) )?(\/api(?:\/[^`\s]*)?)`/g)) {
        // "the routes under `/api/x`" names a prefix, not one route.
        const under = /\bunder\s+(?:`[^`]*`\s+and\s+)?$/.test(text.slice(0, match.index));
        routeReference('Documents', under ? `${match[2]}/*` : match[2], file, line, {
            writtenAs: match[0].slice(1, -1),
            more: match[1] ? { 'socio:httpMethod': [literal(match[1])] } : {},
        });
    }
}

// ── Facts: Effect tags ───────────────────────────────────────────────────

const tagIri = (name) => `sid:tag-${name}`;
const TAG_CLASS = /\bclass\s+(\w+)\s+extends\s+Context\.(Service|Tag|Reference)\b/g;
/** `const X = Context.Reference<...>('id', { defaultValue })`: a tag with a default. */
const TAG_CONST = /\bconst\s+(\w+)\s*=\s*Context\.(Reference|Service|Tag)\b/g;
const PROVIDE =
    /\b(?:Layer\.(?:succeed|effect|sync|scoped|effectContext|succeedContext)|Context\.(?:make|add)|Effect\.provideService|Layer\.mock|alias)\(\s*(\w+)\s*[,)]/g;
for (const file of serverCode.concat(
    FILES.filter((path) => path.startsWith('src/') && !path.startsWith(`${SERVER}/`) && isAppCode(path)),
)) {
    const text = code(file);
    const lineOf = lineIndex(text);
    const inContract = /^src\/server\/[^/]+\/contract\.ts$/.test(file);
    for (const match of [...text.matchAll(TAG_CLASS), ...text.matchAll(TAG_CONST)]) {
        facts.add(tagIri(match[1]), 'a', 'socio:EffectTag');
        facts.add(tagIri(match[1]), 'rdfs:label', literal(match[1]));
        if (inContract) {
            facts.add(tagIri(match[1]), 'socio:inContract', boolean(true));
        }
        if (match[2] === 'Reference') {
            facts.add(tagIri(match[1]), 'socio:hasDefault', boolean(true));
        }
        mention('Defines', tagIri(match[1]), file, lineOf(match.index));
    }
    for (const match of text.matchAll(PROVIDE)) {
        if (/^[A-Z]/.test(match[1])) {
            facts.add(tagIri(match[1]), 'a', 'socio:EffectTag');
            facts.add(tagIri(match[1]), 'rdfs:label', literal(match[1]));
            mention('Provides', tagIri(match[1]), file, lineOf(match.index + match[0].indexOf(match[1], 6)));
        }
    }
}

// ── Facts: tables, their soft-delete columns and their deletes ───────────

const tableIri = (name) => `sid:table-${name}`;
/** The tables of CONCEPT_TABLES go to repo.ttl, for the checks Erden runs; the rest to the facts. */
const PERSONAL_TABLES = new Set(Object.values(CONCEPT_TABLES).flat());
const tableGraph = (name) => (PERSONAL_TABLES.has(name) ? repo : facts);
const SOFT_DELETE = /\b(deletedAt|deleted_at|forgottenAt|forgotten_at)\b/;
const tables = new Set();
function tableThing(name) {
    tables.add(name);
    const graph = tableGraph(name);
    graph.add(tableIri(name), 'a', 'socio:Table');
    graph.add(tableIri(name), 'rdfs:label', literal(name));
    graph.add(tableIri(name), 'socio:tableName', literal(name));
    return tableIri(name);
}
/** The text from `open` to its balanced closing character. */
function balanced(text, open, left, right) {
    let depth = 0;
    for (let at = open; at < text.length; at += 1) {
        if (text[at] === left) {
            depth += 1;
        } else if (text[at] === right && --depth === 0) {
            return text.slice(open, at + 1);
        }
    }
    return text.slice(open);
}
const storeCode = FILES.filter((path) => isAppCode(path) && (path.startsWith('src/') || path.startsWith('packages/')));
const drizzleNames = new Map();
for (const file of storeCode) {
    const text = code(file);
    const lineOf = lineIndex(text);
    for (const match of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?["`]?(\w+)["`]?\s*\(/gi)) {
        const thing = tableThing(match[1]);
        mention('Defines', thing, file, lineOf(match.index), { graph: tableGraph(match[1]) });
        const body = balanced(text, match.index + match[0].length - 1, '(', ')');
        const soft = SOFT_DELETE.exec(body);
        if (soft) {
            tableGraph(match[1]).add(thing, 'socio:softDeleteColumn', literal(soft[1]));
        }
    }
    for (const match of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*sqliteTable\(\s*['"](\w+)['"]\s*,\s*\{/g)) {
        const thing = tableThing(match[2]);
        drizzleNames.set(match[1], match[2]);
        mention('Defines', thing, file, lineOf(match.index), { graph: tableGraph(match[2]) });
        const body = balanced(text, match.index + match[0].length - 1, '{', '}');
        const soft = /\b(deletedAt|deleted_at|forgottenAt|forgotten_at)\s*:/.exec(body);
        if (soft) {
            tableGraph(match[2]).add(thing, 'socio:softDeleteColumn', literal(soft[1]));
        }
    }
    for (const match of text.matchAll(/ALTER TABLE ["`]?(\w+)["`]?\s+ADD (?:COLUMN )?["`]?(\w+)/gi)) {
        if (SOFT_DELETE.test(match[2])) {
            tableGraph(match[1]).add(tableThing(match[1]), 'socio:softDeleteColumn', literal(match[2]));
        }
    }
}
for (const file of storeCode) {
    const text = code(file);
    const lineOf = lineIndex(text);
    for (const match of text.matchAll(/DELETE FROM ["`]?(\w+)/gi)) {
        if (tables.has(match[1])) {
            mention('Deletes', tableIri(match[1]), file, lineOf(match.index), { graph: tableGraph(match[1]) });
        }
    }
    for (const match of text.matchAll(/UPDATE ["`]?(\w+)["`]?\s+SET\b([^;`]{0,400})/gi)) {
        if (tables.has(match[1]) && SOFT_DELETE.test(match[2])) {
            mention('Deletes', tableIri(match[1]), file, lineOf(match.index), { graph: tableGraph(match[1]) });
        }
    }
    for (const match of text.matchAll(/\.(delete|update)\(\s*(\w+)\s*\)([\s\S]{0,200})/g)) {
        const table = drizzleNames.get(match[2]);
        if (table && (match[1] === 'delete' || /\.set\(\s*\{[^}]*\b(?:deletedAt|forgottenAt)\b/.test(match[3]))) {
            mention('Deletes', tableIri(table), file, lineOf(match.index), { graph: tableGraph(table) });
        }
    }
}
// The purge (src/server/purge/references.ts) deletes each kind's own table (ENTITIES) and
// the rows that belong to a purged record (`owns`, `child`); `history` rows stay by design.
const PURGE_REFERENCES = 'src/server/purge/references.ts';
if (FILE_SET.has(PURGE_REFERENCES)) {
    const text = read(PURGE_REFERENCES);
    const lineOf = lineIndex(text);
    for (const match of text.matchAll(/\b(owns|child|history)\(\s*'(\w+)'|\b\w+:\s*\{\s*table:\s*'(\w+)'/g)) {
        const name = match[2] ?? match[3];
        if (tables.has(name)) {
            mention(
                match[1] === 'history' ? 'Retains' : 'Deletes',
                tableIri(name),
                PURGE_REFERENCES,
                lineOf(match.index),
                {
                    graph: tableGraph(name),
                },
            );
        }
    }
}
for (const [concept, names] of Object.entries(CONCEPT_TABLES)) {
    for (const name of names) {
        repo.add(`socio:${concept}`, 'socio:storedIn', tableThing(name));
    }
}

// ── Write ────────────────────────────────────────────────────────────────

const outputs = [
    [
        GENERATED[0],
        repo,
        'The Socio repository: packages, apps, server features, client modules, and the tables that hold personal data.',
    ],
    [
        GENERATED[1],
        facts,
        'Cross-file facts for ontology/queries/checks: files, and the paths, settings, flags, routes, tags and tables each file mentions.',
    ],
];
for (const [path, graph, about] of outputs) {
    mkdirSync(posix.dirname(abs(path)), { recursive: true });
    writeFileSync(abs(path), graph.serialize(about));
    console.log(`${path}: ${graph.subjects.size} subjects, ${graph.size} triples`);
}
