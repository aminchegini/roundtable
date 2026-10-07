# Releasing Roundtable

Roundtable ships as a small, platform-independent `.vsix`: your code plus the vendor SDKs' JavaScript. The vendors' CLI binaries are **not** inside; the extension finds the CLIs the user installed (see [providers.md](providers.md)). That keeps the package under 25 MB (CI fails above that) and identical on every OS.

## One-time setup

**VS Code Marketplace**
1. Sign in at https://marketplace.visualstudio.com/manage with a Microsoft account and create publisher **`eminhikmet`** (must match `publisher` in `package.json`).
2. In Azure DevOps (https://dev.azure.com → User settings → Personal access tokens) create a token: Organization *All accessible organizations*, scope **Marketplace → Manage**. Copy it once.
3. GitHub repo → Settings → Secrets and variables → Actions → **`VSCE_PAT`**.

**Open VSX** (Cursor, VSCodium, Windsurf, Gitpod read from here)
1. Sign in at https://open-vsx.org with GitHub, agree to the publisher agreement, create namespace **`eminhikmet`**.
2. Profile → Access Tokens → create one → secret **`OVSX_PAT`**.

**GitHub environment**
Settings → Environments → **`marketplace`** → *Required reviewers*: you. The publish job waits for your approval, so a stolen token or a bad tag cannot ship an update on its own.

## Cutting a release

```bash
# on main, clean tree, CI green
npm run release -- 0.4.0          # bumps package.json, dates the CHANGELOG, commits "Release 0.4.0", tags v0.4.0
git push && git push origin v0.4.0
```

The tag triggers `.github/workflows/release.yml`:

1. **build** — typecheck, tests, build, `check:package` (file list and denylist), `vsce package`, size cap, `check:vsix` (imports the vendor bundles from the extracted package), checks that the tag matches `package.json`.
2. **publish** (after your approval) — Marketplace, Open VSX, GitHub Release with the `.vsix` and the CHANGELOG section as notes.

`"preview": true` in `package.json` makes the Marketplace listing a **pre-release** (`vsce publish --pre-release`) and the GitHub Release a pre-release. For the first stable version remove the flag and bump the minor (the Marketplace recommends `major.EVEN.patch` for stable and `major.ODD.patch` for pre-release once both channels exist; until then any version works).

## Versioning

- Patch: fixes, docs. Minor: features. Major: incompatible changes to stored data or settings — the `roundtable.schemaVersion` migration hook in `Workspace.open` is where upgrades of stored rooms/agents go.
- Every user-visible change gets a line under `## Unreleased` in `CHANGELOG.md`; the release script moves that section under the version.

## Hotfix

Branch from the tag (`git checkout -b hotfix/0.4.1 v0.4.0`), fix, PR to `main`, then `npm run release -- 0.4.1` on `main`.

## Rolling back

The Marketplace cannot replace a published version; publish a higher patch with the fix. `vsce unpublish` removes the whole extension (all versions) and should be a last resort. Open VSX behaves the same.

## Testing a package locally

```bash
npm run package                    # roundtable-<version>.vsix
npm run check:package              # file list, denylist, size cap
npm run check:vsix                 # imports the bundles from the extracted .vsix
code --install-extension roundtable-<version>.vsix
```
