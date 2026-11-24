import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds a self-contained preview of the rigged Locals (marketing/locals.html
// is one, kept for marketing; rebuild it when the rigs change):
//   node scripts/locals/preview.mjs <out.html> [entry.ts]
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const raw = {
    name: 'raw',
    setup(b) {
        b.onResolve({ filter: /\?raw$/ }, (a) => ({
            path: resolve(a.resolveDir, a.path.slice(0, -4)),
            namespace: 'raw',
        }));
        b.onLoad({ filter: /.*/, namespace: 'raw' }, async (a) => ({
            contents: await readFile(a.path, 'utf8'),
            loader: 'text',
        }));
    },
};
const out = await build({
    entryPoints: [process.argv[3] ? resolve(process.argv[3]) : join(here, 'preview-entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    minify: true,
    plugins: [raw],
});
const js = out.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Locals rig preview</title><style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fff;color:#242424}
main{max-width:900px;margin:0 auto;padding:20px}
#big{width:min(420px,90vw);aspect-ratio:1;margin:0 auto}#big svg,.av svg,#sizes svg{width:100%;height:100%;display:block}
#buttons{margin:14px 0 26px}.row{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:8px}
button{font:inherit;font-size:14px;border:1px solid #e7e7e7;background:#fff;border-radius:999px;padding:6px 14px}
button.on{background:#438c81;color:#fff;border-color:#438c81}
#strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}
figure{margin:0;text-align:center;font-size:13px;color:#707070}.av{aspect-ratio:1}
#sizes{margin-top:24px}#sizes .row{gap:16px;align-items:end;margin-bottom:16px}
h3{grid-column:1/-1;font-size:15px;margin:14px 0 0}
h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#707070;margin:28px 0 10px}
</style></head><body><main><div id="big"></div><div id="buttons"></div>
<h2>Every state</h2><div id="strip"></div><h2>App sizes (20, 36, 54, 96 px)</h2><div id="sizes"></div></main>
<script>${js}</script></body></html>`;
await writeFile(process.argv[2], html);
console.log('wrote', process.argv[2], html.length, 'bytes');
