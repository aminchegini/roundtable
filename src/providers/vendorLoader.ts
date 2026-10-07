import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The vendor SDKs are built into dist/vendor/<name>.mjs (see esbuild.mjs) and
 * loaded on first use. The extension sets the root at activation; tests and
 * scripts point it at the repo after `npm run build`.
 */
export type VendorName = 'claude' | 'codex' | 'copilot';

let root: string | undefined;
const cache = new Map<VendorName, Promise<unknown>>();

export function setVendorRoot(dir: string): void {
  root = dir;
  cache.clear();
}

export function vendorRoot(): string {
  if (root) return root;
  // Default: the nearest ancestor of this file that holds a package.json — the
  // extension folder (dist/extension.js) or the repo (src/providers/*.ts under tests).
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, 'package.json')) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

export function vendorBundlePath(name: VendorName): string {
  return path.join(vendorRoot(), 'dist', 'vendor', `${name}.mjs`);
}

export function loadVendor<T = unknown>(name: VendorName): Promise<T> {
  let pending = cache.get(name);
  if (!pending) {
    const file = vendorBundlePath(name);
    if (!fs.existsSync(file)) {
      pending = Promise.reject(new Error(`Vendor bundle missing: ${file}. Run \`npm run build\`.`));
    } else {
      // A file URL works on every platform, including Windows drive letters.
      pending = import(pathToFileURL(file).href);
    }
    cache.set(name, pending);
    pending.catch(() => cache.delete(name));
  }
  return pending as Promise<T>;
}
