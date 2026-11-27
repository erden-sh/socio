import { copyFile } from 'node:fs/promises';

for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES']) {
    await copyFile(new URL(`../../../${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url));
}
