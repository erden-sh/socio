// The page's own rules, after TipTap's stylesheet in the document's one
// <style> (scripts/build-editor.mts hashes it into the CSP). tentap's page
// layout (CB-417: one scroll holding the title, then the text), the placeholder, task lists, tables, code and the atoms' frames.
// Colors and the type size are CSS variables the bridge sets through the
// CSSOM (the editor bridge's `socio-appearance`: `--color-<token>` from the theme,
// `--socio-font-scale`); the fallbacks are the light theme's. The background
// stays transparent: the native screen draws it.
export const PAGE_CSS = `body{margin:0;padding:0;font:calc(17px*var(--socio-font-scale,1))/1.5 -apple-system,system-ui,sans-serif;color:var(--color-foreground,#242424);background:transparent}
.socio-scroll{position:absolute;top:0;right:0;bottom:0;left:0;overflow-x:hidden;overflow-y:auto;display:flex;flex-direction:column;box-sizing:border-box;padding:var(--socio-inset-top,0px) 0 var(--socio-inset-bottom,0px)}
.socio-title{display:block;flex:none;box-sizing:border-box;width:100%;margin:0;border:0;border-radius:0;padding:12px 16px 0;resize:none;overflow:hidden;background:transparent;color:var(--color-foreground,#242424);font:700 calc(28px*var(--socio-font-scale,1))/1.2 -apple-system,system-ui,sans-serif;letter-spacing:-.01em;outline:none;caret-color:var(--color-primary,#38766d);-webkit-appearance:none;appearance:none}
.socio-title::placeholder{color:var(--color-muted-foreground,#6b6b6b);opacity:1}
.tentap-root{flex:1 0 auto;display:flex;flex-direction:column}
#root div .ProseMirror{flex:1 0 auto;overflow:visible;display:flow-root;box-sizing:border-box;padding:16px;caret-color:var(--color-primary,#38766d)}
.ProseMirror:focus{outline:none}
.ProseMirror a{color:var(--color-primary,#38766d)}
.highlight-background{background-color:var(--color-accent,#f1f1f1)}
.ProseMirror p.is-editor-empty:first-child::before{content:attr(data-placeholder);color:var(--color-muted-foreground,#6b6b6b);float:left;height:0;pointer-events:none}
ul[data-type=taskList]{list-style:none;padding-left:4px}
ul[data-type=taskList] li{display:flex;gap:8px}
table{border-collapse:collapse}td,th{border:1px solid var(--color-border,#e7e7e7);padding:4px 8px}
pre,code{background:var(--color-muted,#f1f1f1)}
pre{padding:8px;border-radius:8px;overflow-x:auto}
blockquote{border-left:3px solid var(--color-border,#e7e7e7);margin-left:0;padding-left:12px;color:var(--color-muted-foreground,#6b6b6b)}
[data-dataset-view],[data-embed-card],[data-page-image]{border:1px solid var(--color-border,#e7e7e7);border-radius:12px;padding:12px;margin:8px 0;color:var(--color-muted-foreground,#6b6b6b)}
[data-page-image] img{display:block;max-width:100%;height:auto;border-radius:8px}`;
