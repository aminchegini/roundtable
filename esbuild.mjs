import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// Extension host bundle. The vendor SDKs are ESM-only and locate their bundled
// CLIs relative to import.meta.url, so they stay external (resolved from
// node_modules at runtime) and are loaded with dynamic import().
const host = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', '@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', '@github/copilot-sdk'],
  sourcemap: true,
};

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
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(host), esbuild.context(webview)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all([esbuild.build(host), esbuild.build(webview)]);
}
