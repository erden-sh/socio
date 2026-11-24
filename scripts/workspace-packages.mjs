// The workspace packages that build to dist with NodeNext (`exports` names
// dist), lowest first, so a package's build finds its dependencies' declarations.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

/** `@socio/*` names this manifest depends on. */
export const workspaceDependencies = (manifest) =>
    Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => name.startsWith('@socio/'));

/** Each as `{ name, dir, manifest, tsconfig, build }`, dependencies before dependents; throws on a cycle. */
export function builtPackages(root) {
    const found = new Map();
    for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
        const dir = join('packages', entry.name);
        if (!entry.isDirectory() || !existsSync(join(root, dir, 'package.json'))) {
            continue;
        }
        const manifest = manifestOf(join(root, dir));
        if (manifest.exports?.['./*']?.default === './dist/*.js') {
            const buildConfig = join(dir, 'tsconfig.build.json');
            found.set(manifest.name, {
                name: manifest.name,
                dir,
                manifest,
                tsconfig: join(dir, 'tsconfig.json'),
                build: existsSync(join(root, buildConfig)) ? buildConfig : join(dir, 'tsconfig.json'),
            });
        }
    }
    const ordered = [];
    const state = new Map();
    const visit = (name, path) => {
        if (state.get(name) === 'done' || !found.has(name)) {
            return;
        }
        if (state.get(name) === 'visiting') {
            throw new Error(`Workspace packages form a cycle: ${[...path, name].join(' -> ')}`);
        }
        state.set(name, 'visiting');
        for (const dependency of workspaceDependencies(found.get(name).manifest)) {
            visit(dependency, [...path, name]);
        }
        state.set(name, 'done');
        ordered.push(found.get(name));
    };
    for (const name of [...found.keys()].sort()) {
        visit(name, []);
    }
    return ordered;
}
