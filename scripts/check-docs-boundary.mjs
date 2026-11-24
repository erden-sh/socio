import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Content stays server-only, including imports added after the initial platform. */
export async function checkDocsBoundary(root = process.cwd()) {
    for (const manifest of ['package.json', 'packages/client/package.json']) {
        const pkg = JSON.parse(await readFile(resolve(root, manifest), 'utf8'));
        if (['dependencies', 'devDependencies'].some((k) => Object.keys(pkg[k] ?? {}).includes('fumadocs-mdx'))) {
            throw Error('Docs content compiler must remain server-only');
        }
    }
    async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const file = resolve(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(file);
            } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
                const source = await readFile(file, 'utf8');
                for (const match of source.matchAll(
                    /(?:\bfrom\s*|\bimport\s*(?:\(|)|\brequire\s*\()\s*['"]([^'"]+)['"]/g,
                )) {
                    if (
                        /(?:^|\/)content(?:\/|$)|(?:^|\/)server\/docs(?:\/|$)|\.mdx?$/.test(match[1]) ||
                        match[1].startsWith('fumadocs-mdx')
                    ) {
                        throw Error('Client import crosses docs content boundary: ' + file);
                    }
                }
                if (/\b(?:useFumadocsLoader|createClientLoader|serializePageTree)\b/.test(source)) {
                    throw Error('Client content loader is not allowed: ' + file);
                }
            }
        }
    }
    await walk(resolve(root, 'packages/client/src'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await checkDocsBoundary();
    console.log('Docs content boundary passed');
}
