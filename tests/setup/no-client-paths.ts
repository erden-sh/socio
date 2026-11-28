import { join, resolve, sep } from 'node:path';

// The server bucket excludes UI packages. Tests that read them belong in tests/integration.
const root = join(import.meta.dirname, '../..');
const CLIENT_PACKAGE_NAMES = ['client', 'plugin-ui', 'ui'];
const CLIENT_SIDE = CLIENT_PACKAGE_NAMES.map((name) => join(root, 'packages', name));

export const isClientSide = (path: string) => {
    const full = resolve(root, path);
    return CLIENT_SIDE.some((dir) => full === dir || full.startsWith(`${dir}${sep}`));
};

export const reachMessage = (path: string) =>
    `A test in the server bucket reached ${path}. Client changes don't rerun that bucket, so this test could stay green on a broken client: move it to tests/integration (AGENTS.md, "Checks").`;
