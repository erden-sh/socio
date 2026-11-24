import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { remarkHeading } from 'fumadocs-core/mdx-plugins/remark-heading';
import { initSimpleSearch } from 'fumadocs-core/search/server';
import { loader } from 'fumadocs-core/source';
import type { Root } from 'hast';
import { toText } from 'hast-util-to-text';
import type { Root as MarkdownRoot, RootContent } from 'mdast';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { parseDocument } from 'yaml';

import type { DocsPage, DocsScreen, DocsTree } from '@socio/shared/docs';
import type { Role } from '@socio/shared/types';

import { AUDIENCES, type DocsAudience as Audience, type DocsCatalogShape, type DocsFile } from './contract.js';

interface Page extends DocsPage {
    audience: Audience;
    markdown: string;
    text: string;
    links: string[];
}
const rank = { user: 0, admin: 1, operate: 2 };
// Admins read the guides to running Socio too (CB-390: no operator role).
const level = (role?: Role) => (role === 'admin' ? 2 : 0);
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const section = {
    user: 'User guides',
    admin: 'Admin guides',
    operate: 'Running Socio',
};
const base = { user: '/docs', admin: '/docs/admin', operate: '/docs/operate' };
function hasControl(text: string) {
    return [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}
function insist(value: unknown, message: string): asserts value {
    if (!value) {
        throw Error(`Docs: ${message}`);
    }
}

/** Real directories and regular, singly-linked files only; bounded startup I/O. */
export async function readDocs(root = resolve('content/docs')): Promise<DocsFile[]> {
    insist((await realpath(root)) === resolve(root) && (await lstat(root)).isDirectory(), 'real content root required');
    const result: DocsFile[] = [];
    let total = 0;
    const roots = await readdir(root);
    insist(
        roots.length === 3 && roots.every((n) => AUDIENCES.includes(n as Audience)),
        'exact audience directories required',
    );
    for (const audience of AUDIENCES) {
        const dir = resolve(root, audience);
        insist(
            (await lstat(dir)).isDirectory() && !(await lstat(dir)).isSymbolicLink(),
            'real audience directory required',
        );
        for (const name of (await readdir(dir)).sort()) {
            insist(NAME.test(name), 'plain Markdown filename required');
            const file = resolve(dir, name),
                stat = await lstat(file);
            insist(
                stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 131072,
                'bounded regular content file required',
            );
            total += stat.size;
            insist(result.length < 256 && total <= 8 * 1024 * 1024, 'content limit exceeded');
            result.push({
                audience,
                name,
                markdown: new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file)),
            });
        }
    }
    return result;
}

function walk(node: MarkdownRoot | RootContent, each: (node: RootContent) => void) {
    if (node.type !== 'root') {
        each(node);
    }
    if ('children' in node) {
        for (const child of node.children) {
            walk(child as RootContent, each);
        }
    }
}
async function compile(file: DocsFile): Promise<Page> {
    insist(AUDIENCES.includes(file.audience) && NAME.test(file.name), 'invalid source identity');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(file.markdown);
    insist(match, 'title and description frontmatter required');
    const doc = parseDocument(match[1], { uniqueKeys: true });
    insist(doc.errors.length === 0, 'invalid frontmatter');
    const meta = doc.toJS() as Record<string, unknown>;
    insist(
        meta && typeof meta === 'object' && Object.keys(meta).sort().join(',') === 'description,title',
        'only title and description frontmatter allowed',
    );
    for (const k of ['title', 'description']) {
        insist(
            typeof meta[k] === 'string' &&
                (meta[k] as string).length > 0 &&
                (meta[k] as string).length <= 500 &&
                !hasControl(meta[k] as string) &&
                !/[<>]/.test(meta[k] as string),
            'plain metadata required',
        );
    }
    const links: string[] = [];
    const pipeline = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(() => (tree: MarkdownRoot) => {
            walk(tree, (node) => {
                insist(
                    node.type !== 'html' && node.type !== 'image' && node.type !== 'imageReference',
                    'raw HTML and image embeds are not supported',
                );
                if (node.type === 'link' || node.type === 'definition') {
                    insist(
                        !hasControl(node.url) &&
                            !/[\s\\]/.test(node.url) &&
                            (node.url.startsWith('https://') ||
                                /^\/(?!\/)/.test(node.url) ||
                                /^#[a-z0-9_-]+$/i.test(node.url)),
                        'only HTTPS or local links allowed',
                    );
                    if (node.url.startsWith('/docs')) {
                        links.push(node.url.split(/[?#]/)[0]);
                    }
                }
            });
        })
        .use(remarkHeading, { customId: false })
        .use(remarkRehype)
        .use(rehypeSanitize, { ...defaultSchema, clobberPrefix: '' });
    const parsed = pipeline.parse(match[2]);
    const { VFile } = await import('vfile');
    const vfile = new VFile();
    const body = (await pipeline.run(parsed, vfile)) as Root;
    const toc = (vfile.data.toc ?? []).map((item) => {
        insist(typeof item.title === 'string', 'text heading required');
        return { title: item.title, url: item.url, depth: item.depth };
    });
    const slug = file.name === 'index.md' ? '' : '/' + file.name.slice(0, -3);
    insist(file.audience !== 'user' || !['/admin', '/operate', '/search'].includes(slug), 'reserved user page');
    return {
        audience: file.audience,
        url: base[file.audience] + slug,
        title: meta.title as string,
        description: meta.description as string,
        body,
        toc,
        markdown: file.markdown,
        text: toText(body),
        links,
    };
}

/** Separate server-only indexes and trees: inaccessible content is never serialized. */
export async function buildDocsCatalog(files: DocsFile[]): Promise<DocsCatalogShape> {
    const pages = await Promise.all(files.map(compile));
    insist(new Set(pages.map((p) => p.url)).size === pages.length, 'duplicate page URL');
    for (const page of pages) {
        for (const link of page.links) {
            const target = pages.find((p) => p.url === link);
            insist(target && rank[target.audience] <= rank[page.audience], 'missing or restricted cross-audience link');
        }
    }
    const views = [0, 1, 2].map((access) => {
        const allowed = pages.filter((p) => rank[p.audience] <= access);
        const children: DocsTree['children'] = [];
        for (const audience of AUDIENCES.filter((a) => rank[a] <= access)) {
            const own = allowed.filter((p) => p.audience === audience);
            // Fumadocs assigns canonical slugs from a virtual, server-only source.
            const source = loader({
                baseUrl: base[audience],
                source: {
                    files: own.map((p) => ({
                        type: 'page' as const,
                        path: p.url === base[audience] ? 'index.md' : p.url.slice(base[audience].length + 1) + '.md',
                        data: { title: p.title, description: p.description },
                    })),
                },
            });
            children.push({
                type: 'folder',
                name: section[audience],
                children: source.getPages().map((p) => ({
                    type: 'page',
                    name: p.data.title ?? 'Guide',
                    url: p.url,
                })),
            });
        }
        const search = initSimpleSearch({
            indexes: allowed.map((p) => ({
                title: p.title,
                description: p.description,
                url: p.url,
                content: p.text,
            })),
        });
        return {
            pages: new Map(allowed.map((p) => [p.url, p])),
            tree: { name: 'Socio help', children },
            search,
        };
    });
    let activeSearches = 0;
    const forRole = (role?: Role) => views[level(role)];
    return {
        digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
        screen(url: string, role?: Role): DocsScreen | null {
            const view = forRole(role),
                page = view.pages.get(url);
            if (!page) {
                return null;
            }
            return {
                page: {
                    url: page.url,
                    title: page.title,
                    description: page.description,
                    body: page.body,
                    toc: page.toc,
                },
                tree: view.tree,
            };
        },
        /** The viewer's navigation alone, for a page that isn't theirs to open. */
        tree(role?: Role): DocsTree {
            return forRole(role).tree;
        },
        list(role?: Role) {
            return [...forRole(role).pages.values()].map(({ url, title, description }) => ({
                url,
                title,
                description,
            }));
        },
        markdown(url: string, role?: Role) {
            return forRole(role).pages.get(url)?.markdown ?? null;
        },
        llms(full: boolean, role?: Role) {
            const visible = [...forRole(role).pages.values()];
            return (
                '# Socio documentation\n\n' +
                visible
                    .map((p) =>
                        full
                            ? `## ${p.title}\n\nSource: ${p.url}.md\n\n${p.markdown}\n`
                            : `- [${p.title}](${p.url}.md): ${p.description}`,
                    )
                    .join('\n')
            );
        },
        async search(query: string, role?: Role) {
            if (!query.trim()) {
                return [];
            }
            insist(query.length <= 128 && activeSearches < 8, 'search limit');
            activeSearches++;
            try {
                return (await forRole(role).search.search(query, { limit: 20 })).slice(0, 20);
            } finally {
                activeSearches--;
            }
        },
    };
}
export type DocsCatalog = Awaited<ReturnType<typeof buildDocsCatalog>>;

let startup: Promise<DocsCatalog> | undefined;
/** Shared process catalog, compiled once before serving; identity is never cached here. */
export function getDocsCatalog() {
    return (startup ??= readDocs().then(buildDocsCatalog));
}
