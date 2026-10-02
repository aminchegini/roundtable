import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// Extension host bundle. The Agent SDK is ESM-only and locates files relative
// to itself, so it stays external and is loaded with a dynamic import().
const host = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', '@anthropic-ai/claude-agent-sdk'],
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
