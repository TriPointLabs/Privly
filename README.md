# Privly

Privly brings Microsoft Entra and Azure PIM (Privileged Identity Management) into a browser extension. Elevate roles, track activations and expirations, manage approvals, and receive expiry notifications, all without touching the Azure portal.

## Features

- Activate and deactivate eligible Entra roles, PIM-enabled groups, and Azure resource roles
- Approve, deny, and cancel pending PIM requests, whether you are the approver or the requester
- Expiry notifications with a configurable lead time and distinct notification sounds
- Multiple accounts across multiple tenants at the same time
- Step-up authentication handled in the activation flow, including MFA and Conditional Access authentication contexts
- Privacy focused: all data stays local in IndexedDB, and diagnostic logs are redacted before they are written
- Built-in debug panel with a state snapshot, a per-account entitlement map, and a filterable log viewer

## We Need Your Help!

Privly's sign-in flow performs OpenID Connect cloud discovery and resolves the correct login, Graph, and ARM endpoints for Microsoft's sovereign clouds (GCC, GCC High, DoD). The plumbing exists, but we cannot honestly claim support without validating against a real sovereign tenant, and those are not something you can just sign up for.

If your organization runs in GCC High or DoD and would like Privly there, we would love to partner with you to test and harden that support. Open an issue or reach out through [support.tripointlabs.com](https://support.tripointlabs.com).

## Requirements

- Node.js 22+
- npm 10+

## Getting Started

```bash
npm install
npm run dev
```

`npm run dev` is the primary development command. It starts a Vite watch build targeting Chrome, writes output to `dist/`, and rebuilds on every file change. Development builds include the console log mirror and the reload client; production builds strip both.

To load the extension: go to `chrome://extensions`, enable Developer Mode, and click "Load unpacked" pointing to the `dist/` directory. Reload the extension there after each build.

### Firefox development

```bash
npm run dev:firefox
```

Same as `npm run dev` but targets Firefox. To load: go to `about:debugging > This Firefox > Load Temporary Add-on` and select `dist/manifest.json`.

## All Commands

| Command | Description |
|---|---|
| `npm run dev` | Vite watch build for Chrome (development mode) |
| `npm run dev:firefox` | Vite watch build for Firefox (development mode) |
| `npm run build:chrome` | Production Chrome build, outputs a zip to `artifacts/` |
| `npm run build:firefox` | Production Firefox build, outputs a zip to `artifacts/` |
| `npm run clean` | Delete `dist/`, `.chrome-profile/`, and `.firefox-profile/` |
| `npx tsc --noEmit` | Type-check without emitting files |

## Project Structure

```
src/
  popup/          Svelte 5 popup UI (data.ts owns all read-only IndexedDB queries)
  background/     MV3 service worker: sync engine, auth, activation engine,
                  expiry notifications, redacted logging
  tools/          Shared libraries (IndexedDB wrapper, OAuth/PKCE primitives)
  types/          Shared types and the popup to service worker message contract
  manifests/      manifest.chrome.json, manifest.firefox.json
build/
  reloadPlugin.ts Dev-only reload plugin
  scripts/        Build helpers (copy-manifest, set-version)
.github/
  workflows/      CI/CD (dev.yml, release.yml)
```

## Architecture Notes

The popup and the service worker never share memory. The service worker owns all writes to IndexedDB and all Microsoft Graph and ARM calls; the popup reads IndexedDB directly and triggers actions through a typed message contract. Policy data is cached with a 4-hour TTL, list endpoints are always paginated, and every activation path runs through a single shared step-up engine.

## CI/CD

Two GitHub Actions workflows handle builds and releases.

**`dev` branch**: every push builds and attaches a downloadable artifact to the workflow run:
- `privly-{version}.{run}-{sha}-chrome.zip`

**Version tags on `main`** (e.g. `v2.4.0`): triggers a release build that packages the Chrome zip and attaches it to a GitHub Release. Store submission is currently a manual step, and the Firefox packaging steps are commented out until AMO signing is set up.

To cut a release: bump the version in `package.json` on `main`, then tag and push:

```bash
git tag v2.4.0
git push origin v2.4.0
```

## Tech Stack

- [Svelte 5](https://svelte.dev) (runes syntax) for the popup UI
- [Vite 8](https://vitejs.dev) build tooling (Rolldown bundler)
- [Tailwind CSS 4](https://tailwindcss.com) styling
- [Bits UI](https://bits-ui.com) headless dialog and popover primitives
- [idb](https://github.com/jakearchibald/idb) IndexedDB wrapper
- [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) cross-browser API
- [web-ext](https://github.com/mozilla/web-ext) extension packaging and signing

## License

Privly is licensed under the [GNU General Public License v3.0](LICENSE).

Copyright (c) 2026 TriPoint Labs, LLC
