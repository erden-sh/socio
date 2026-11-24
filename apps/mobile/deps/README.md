# Forked packages

## react-native-enriched-markdown

`react-native-enriched-markdown-1.2.0-t3.16-29ddd424-grammars.tgz` is T3 Code's fork of Software
Mansion's enriched-markdown (the chat's Markdown, rendered natively by md4c), with its code-highlighting
grammars added.

**Why the fork.** Upstream's newest listed React Native is 0.87; T3 Code's fork runs on 0.88 and caps
native memory while a reply streams (an 8 MiB measurement-key budget, coalesced renders). It also
carries the link list (`onLinksChange`) that link chips read, and fixes with open upstream PRs. T3
Code's `apps/mobile/deps/README.md` (commit 240446e2d9) lists them. Move back to upstream once a
release lists React Native 0.88 and carries those changes.

**Where it comes from.** T3 Code's `react-native-enriched-markdown-1.2.0-t3.16-29ddd424.tgz` at commit
240446e2d9 (sha256 `631a0261…813d5`), packed from `pingdotgg/enriched-markdown`'s `fork/t3-mobile` at
`29ddd424` (its `t3-fork.json`). Only `cpp/highlight/vendor/` differs.

**Why the grammars are in it.** The package's postinstall downloads the tree-sitter runtime from GitHub
and each grammar from npm. pnpm runs no dependency script unless it is allowed, and CI installs with
no network (12.4), so the root `package.json` lists it in `pnpm.ignoredBuiltDependencies` and the
tarball carries what the script would fetch: the runtime (tree-sitter v0.26.3, checked against
`grammar-versions.json`'s sha256), the 14 grammars `grammar-versions.json` marks `default` (json, html,
css, markdown, yaml, go, java, javascript, python, c, rust, bash, typescript, tsx), each with its
license, and the `.stamp` the native builds look for. The five optional grammars (cpp, swift, php,
ruby, c-sharp, about 120 MB of C) are left out; the build compiles only the default set.

**What the app sets** (`package.json`, `"enriched-markdown"`):

- `enableCodeHighlight: true`, said outright, so a build fails loudly if the grammars are missing
  instead of shipping without highlighting;
- `enableMath: false`: no RaTeX (another download on iOS, a Maven package on Android), and the root's
  `"react-native-enriched-markdown>katex": "-"` override keeps the workspace's `katex` from being linked
  as its optional peer;
- `enableVideo: false`: no native video player (AVKit on iOS, Media3 on Android), so a `<video>` block in
  a reply can't load anything (the chat also rewrites such blocks to text first).

**To rebuild it** (for example, from a newer T3 Code tarball), in a scratch directory with Node 26:

```sh
tar xzf <t3code>/apps/mobile/deps/react-native-enriched-markdown-<version>.tgz   # gives package/
node package/vendor-grammars.mjs --from-npm \
  --vendor-dir package/cpp/highlight/vendor \
  --manifest package/cpp/highlight/grammar-versions.json
rm -rf package/cpp/highlight/vendor/grammars/{cpp,swift,php,ruby,c-sharp}
tar --sort=name --mtime='2026-11-08 00:00Z' --owner=0 --group=0 --numeric-owner -cf - package \
  | gzip -n -9 > react-native-enriched-markdown-<version>-grammars.tgz
```

The script fetches from github.com and registry.npmjs.org (no credentials). Name the file after the
fork's version and source commit, so each build has its own dependency path; update the path in
`package.json`, run `pnpm install` from the root, check that `git diff pnpm-lock.yaml` touches only the
app's importer and this package, and rebuild both native clients. List the change in
`THIRD_PARTY_NOTICES`.
