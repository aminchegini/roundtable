import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const watch = process.argv.includes('--watch');

// Extension host bundle (CommonJS, as VS Code loads it). Nothing vendor-specific
// is imported statically; the vendor SDKs live in separate ESM bundles below and
// are loaded with import() at runtime through src/providers/vendorLoader.ts.
const host = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: watch,
  minify: !watch,
  legalComments: 'none',
};

// Vendor SDK bundles. ESM so import.meta.url keeps working inside the SDKs.
// The vendors' own CLI binaries (hundreds of MB per platform) are NOT shipped:
// every adapter passes an explicit executable path, so the SDKs never resolve
// their bundled platform packages — those stay external and absent.
const vendorExternals = [
  '@openai/codex',
  '@openai/codex-*',
  '@anthropic-ai/claude-agent-sdk-*',
  '@github/copilot-sdk-*',
];

const vendor = (name, entry, extra = {}) => ({
  entryPoints: { [name]: entry },
  outdir: 'dist/vendor',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: vendorExternals,
  sourcemap: false,
  minify: !watch,
  legalComments: 'none',
  // Some SDK dependencies are CommonJS and reach for require(); give ESM output a real one.
  banner: { js: "import { createRequire as __rtCreateRequire } from 'node:module'; const require = __rtCreateRequire(import.meta.url);" },
  logOverride: { 'empty-import-meta': 'silent' },
  ...extra,
});

const vendors = [
  vendor('claude', '@anthropic-ai/claude-agent-sdk'),
  vendor('codex', '@openai/codex-sdk'),
  // koffi (native FFI) is only used for the in-process runtime host, which Roundtable
  // never uses (it drives the copilot CLI over stdio); a stub keeps natives out of the package.
  vendor('copilot', '@github/copilot-sdk', { alias: { koffi: './scripts/stubs/koffi.mjs' } }),
];

const webview = {
  entryPoints: ['webview/main.tsx'],
  outfile: 'dist/webview/main.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  minify: !watch,
  sourcemap: watch,
  legalComments: 'none',
};

const all = [host, webview, ...vendors];

if (watch) {
  const contexts = await Promise.all(all.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(all.map((c) => esbuild.build(c)));
  const size = (f) => `${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} MB`;
  console.log(
    ['dist/extension.js', 'dist/webview/main.js', 'dist/vendor/claude.mjs', 'dist/vendor/codex.mjs', 'dist/vendor/copilot.mjs'].map((f) => `${f} ${size(f)}`).join('\n'),
  );
}
