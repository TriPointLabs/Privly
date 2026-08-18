# Privly v2

## What This Is
Privly brings Microsoft Entra and Azure PIM (Privileged Identity Management) into a browser extension. Users can elevate roles, track activations and expirations, manage approvals (as requester and approver), and receive notifications before roles or group activations expire, all without touching the Azure portal.

Privly is multi-user from the start. Multiple Entra accounts may be active simultaneously across different tenants.

## Project Structure
- `build/reloadPlugin.ts` -- dev-only extension reload plugin (WebSocket-driven)
- `build/scripts/` -- build helpers (`copy-manifest.js`, `set-version.js`)
- `src/background/` -- service worker; all business logic lives here
  - `index.ts` -- entry point: top-level listeners, alarms, startup catch-ups
  - `handlers.ts` -- typed command dispatch table + Entra activation/deactivation/approval handlers
  - `azureHandlers.ts` -- Azure ARM activation/deactivation handlers
  - `activation.ts` -- shared step-up and error-dispatch engine for all activation kinds
  - `auth.ts` -- token lifecycle: sign-in, silent refresh, ARM tokens, step-up (`runAuthCodeFlow` owns the PKCE flow)
  - `sync.ts` -- Graph/ARM data sync, policy engine, `runSyncCycle`
  - `expiry.ts` -- expiry notifications (`checkExpiries` + one-shot `expiry-check` alarm)
  - `badge.ts` -- badge countdown (time left on the soonest-expiring activation) and recurring alarms
  - `log.ts` -- redacted persistent logging (see Logging)
  - `utils.ts` -- fetch wrapper, pagination, polling, policy-rule parsing
  - `tabs.ts` -- portal tab reload after activation
- `src/popup/` -- popup UI (Svelte 5)
  - `data.ts` -- all read-only IndexedDB queries (record -> view model)
  - `components/ui/` -- internal atom components
- `src/tools/` -- shared libraries: `db.ts` (IndexedDB), `oauth.ts` (stateless OAuth/PKCE primitives), `notify.ts`, `scopeParser.ts`, `membership.ts`
- `src/types/` -- `messages.ts` (message contract), `pim.ts` (view models)
- `src/manifests/` -- `manifest.chrome.json`, `manifest.firefox.json`
- `vite.config.ts` -- multi-entry build config

## Commands
- `npm run dev` -- Vite watch build (Chrome) into `dist/`
- `npm run dev:firefox` -- Vite watch build with the Firefox manifest
- `npm run build:chrome` -- production Chrome build; zip lands in `artifacts/`
- `npm run build:firefox` -- production Firefox build; zip lands in `artifacts/`
- `npm run clean` -- removes `dist/` and browser profile dirs (not `artifacts/`)
- `npx tsc --noEmit` -- typecheck

There is no lint script; typecheck + build are the gates after every change.

## Key Conventions
- Svelte 5 runes syntax only (`$state`, `$derived`, `$effect`); no legacy Options API
- webextension-polyfill for all browser API calls (never raw `chrome.*`)
- Dev-only code (reload plugin, console mirroring) gated with `import.meta.env.DEV`
- Service worker registers all event listeners at top level (MV3 requirement)
- Never use `console.*` in `src/` -- use `log()` from `src/background/log.ts` (see Logging)
- Don't use em dashes anywhere
- When producing content, do not split sentences in comments over multiple lines purely for length reasons. It is fine for code but only do this for readability benefits where it makes sense.

## CRITICAL: State Sharing Architecture
**Do not use Svelte stores or any in-memory state to share data between the popup and the service worker. They run in separate contexts and do not share memory.**

### Responsibilities
- **Service worker** -- owns all writes to IndexedDB and all Microsoft Graph/ARM calls. All business logic (elevation, approval, expiry tracking, notifications) runs here.
- **Popup** -- reads IndexedDB in read-only fashion through `src/popup/data.ts`. Never writes to IndexedDB. Triggers actions by sending typed commands to the service worker.

### Data flow
1. Popup opens -> registers message listener synchronously, then reads IndexedDB on mount
2. User triggers action -> popup sends a typed command (`sendCommand`)
3. Service worker performs the action -> writes result to IndexedDB
4. Service worker fires a fire-and-forget `DB_CHANGED` notification (`notifyDbChanged`)
5. Popup coalesces notifications (100ms debounce in MainPage) and re-queries only the affected stores

### CRITICAL: Popup initialization order
Always register the message listener synchronously before any await. If the listener is registered after an await, DB_CHANGED notifications fired during the initial read will be missed.
```ts
// CORRECT
browser.runtime.onMessage.addListener(handler); // synchronous
const data = await readFromDB();                 // await after
```
Components that mount repeatedly (e.g. AzureDetailPage) must remove their listener in `onDestroy`.

### Message contract
All messages between popup and service worker use the typed contract in `src/types/messages.ts`. Never build ad-hoc message objects outside that module:
- Popup -> SW: `sendCommand(MessageType.X, payload)`; every command returns a `CommandAck`
- SW -> popup: `sendNotification({...})` for `DB_CHANGED`, `SYNC_STATUS`, `PLAY_SOUND`
- The service worker routes commands through the typed `commandHandlers` dispatch table in `handlers.ts`; add new commands to `MessageType`, `CommandPayloadMap`, and that table together.

### storage.local usage
Reserved for minimal bootstrap data only: the last active `accountId` and the cached theme preference (for flash-free popup startup). Not used for application data.

## IndexedDB
The `idb` library is used for all IndexedDB access. All schema and query logic lives in `src/tools/db.ts`; the popup's read queries live in `src/popup/data.ts`. These are the only files that touch IndexedDB directly.

### Connection handling
`getDB()` memoizes one connection per JS context (reset on `blocking`/`terminated`). The service worker module re-evaluates on every wake, so each resurrection starts fresh. Do not open connections another way.

### Service worker rules
- Never hold a transaction open across a network call or any non-trivial await. Fetch data first, then open a short transaction only to commit the result.
- Use `replaceForAccount()` for replace-all-records-for-account writes on single stores; keep multi-store writes (e.g. roles + role_definitions) as explicit transactions to preserve atomicity.
- Before writing an account record from a previously-read snapshot, re-read it and merge only the fields you own (concurrent writers exist: token refresh, backfill, step-up persist).

### Popup rules
- Read-only access only, through `src/popup/data.ts`.
- Re-query on `DB_CHANGED` rather than holding data beyond a render cycle; MainPage debounces bursts (~100ms) so each query runs once per burst.
- Azure detail views use the `by-scope`/`by-subscription` compound indexes rather than scanning `by-account` and filtering.

### Schema overview (v15)
Key ownership: `accounts.id` is a locally generated UUID (stable per `tenantId + accountId` pair via the unique `by-tenant-account` index). Child stores use server-issued IDs (Graph schedule IDs, approvalId, ARM instance GUIDs) or composite string keys, and reference `accounts.id` through an `accountId` field with a `by-account` index.

```
accounts          -- id (local UUID), tenantId, accountId (Entra OID), tokens, ...
role_definitions  -- id (Graph roleDefinitionId); by-tenant ('' tenantId = shared built-in)
roles             -- id (Graph eligibility schedule ID); by-account
role_policies     -- id `${tenantId}::${roleDefinitionId}`; by-tenant; lastSyncedAt (TTL)
groups            -- id (Graph eligibility schedule ID); by-account
group_policies    -- id `${tenantId}::${groupId}::${accessId}`; by-tenant; lastSyncedAt (TTL)
activations       -- id (Graph schedule ID); by-account; kind 'role'|'group'; expiry-notification flags
approvals         -- id (Graph approvalId); by-account
pending_requests  -- id (Graph request ID); by-account
activating        -- id (Graph request ID); by-account; in-flight activation spinner state
extension_settings-- single 'global' record (incl. loggingEnabled, logMaxEntries)
states            -- ephemeral operation state (e.g. sign-in progress)
azure_scopes      -- id (ARM scope path); by-account, by-subscription, by-parent
azure_roles       -- id (ARM instance GUID); by-account, by-scope, by-subscription
azure_activations -- id (ARM instance GUID); by-account, by-scope, by-subscription; expiry flags
azure_policies    -- id `${scopeId}::${roleDefinitionId}`; by-account; lastSyncedAt (TTL)
logs              -- autoincrement id; redacted diagnostic ring buffer
```
Migrations are incremental in `getDB()`; bump the version and add a new `if (oldVersion < N)` block.

## Sync and network rules
- All list endpoints are fetched through `fetchAllPages()` (follows `@odata.nextLink`/ARM `nextLink`; never silently truncate). Single resources use `fetchWithRetry` (429 always retried; 5xx/network retried only for GET -- non-idempotent requests must not auto-retry).
- Policies are cached with a 4-hour TTL (`lastSyncedAt` on policy records). The 5-minute `token-refresh` cycle skips fresh policies; `TRIGGER_SYNC` (manual refresh) passes `force: true` and bypasses the TTL; a policy validation failure during activation triggers a silent single-policy refetch (`refreshSingle*Policy`) so the cache heals.
- Post-activation resyncs are targeted: an Entra role action resyncs roles + active assignments only; groups resync groups; Azure resyncs the two Azure stores. Only the periodic cycle runs the full cascade.
- The 1-minute `pending-approval-check` alarm (present only while requests are pending) syncs pending requests + active assignment state only, and is reconciled on sign-out.
- Expiry notifications: `checkExpiries()` in `expiry.ts` fires "expiring soon" (per `notifyMinutesBefore`) and "expired" notifications exactly once per activation (flags carried across sync rewrites while the expiry is unchanged) and schedules a one-shot `expiry-check` alarm at the next exact moment. Sync cycles and SW wake-ups call it as a catch-up.

## Logging and privacy
Production logging goes through `log(level, category, message)` in `src/background/log.ts`, persisted to the `logs` ring buffer (cap = `logMaxEntries` setting) and mirrored to the console only in dev builds. Redaction happens at the write site:
- Never log tokens, claims JSON, justification text, ticket numbers, or full message payloads
- Mask UPNs/emails with `maskUpn()` and GUIDs with `shortId()` before interpolating
- Display names, HTTP statuses, counts, durations, and error codes are allowed

The popup routes its own diagnostics through the `LOG_EVENT` command (category `popup`); window-level catch-alls in App.svelte record unhandled popup errors. Popup log messages must not contain identifiers -- the popup has no redaction helpers.

The Debug panel is a standalone subview (`src/popup/DebugPage.svelte`) reachable from the login page and Settings, so diagnostics work with zero accounts or a broken account. It renders logging controls, a per-account state snapshot, the entitlement map (Entra roles, groups, and the Azure scope tree via the `by-parent`/`by-scope` indexes, with cached-policy freshness and missing-policy highlighting), and the log viewer (level/category/text filters, copy/clear). Logging is on by default; disabling it clears the store (handled service-worker-side). Log writes never fire `DB_CHANGED`.

## CI/CD Pipeline

Two GitHub Actions workflows handle builds and releases.

### Branches and workflows
- `dev` branch -- `.github/workflows/dev.yml` -- every push produces a downloadable Chrome zip (Firefox signing steps are commented out until AMO credentials exist)
- version tag (e.g. `v2.0.0`) on `main` -- `.github/workflows/release.yml` -- builds both browser zips and attaches them to a GitHub Release (store submission is currently manual)

### Versioning strategy
`package.json` is the single source of truth for the version. `copy-manifest.js` reads it and injects the version into `dist/manifest.json` at build time -- the source manifest files do not contain a version field. CI patches only `package.json` in-place on the runner before building -- the change is never committed back.

- Dev artifacts: `{base}.{run_number}` in the manifest (e.g. `2.0.0.42`); short commit SHA appears in the artifact filename only
- Release artifacts: version is stripped from the tag (`v2.0.0` becomes `2.0.0`)

To cut a release:
1. Open a PR that bumps `package.json` to the target version
2. Merge to `main`
3. `git tag v2.0.0 && git push origin v2.0.0` -- this triggers `release.yml`

### Version script
`build/scripts/set-version.js <version>` -- patches `version` in `package.json` (manifests get their version injected at build time).

### Required secrets
| Secret | Used by |
|---|---|
| `AMO_API_KEY` | Dev workflow, currently commented out (signs the unlisted Firefox XPI) |
| `AMO_API_SECRET` | Dev workflow, currently commented out (signs the unlisted Firefox XPI) |

No secrets are required while the Firefox steps are disabled; the release workflow publishes GitHub Release artifacts with the built-in token.

## Accessibility

All interactive elements must meet WCAG 2.1 AA:
- Icon-only buttons: always include `aria-label` (not just `title`)
- Decorative SVGs and icons: always `aria-hidden="true"`
- Disclosure widgets (expand/collapse): `aria-expanded` + `aria-controls` on trigger; matching `id` on panel
- Progress bars: `role="progressbar"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax`, `aria-label`
- Dialogs/overlays: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, focus on open, Escape closes
- Live regions: status/timer text that updates: `aria-live="polite"`
- Buttons with context-dependent actions (Activate, Approve, Deny): include the subject in `aria-label`
- Backdrop overlays: use `<div aria-hidden="true">` with `onclick`, not `<button>` -- keyboard users close via Esc or an explicit close button

## UI Components

Internal atom components live in `src/popup/components/ui/`. Always prefer these over raw Tailwind class strings.

### Button variants
- `icon` -- small ghost button for inline icon actions
- `icon-lg` -- header-bar icon buttons (refresh, settings)
- `icon-danger` -- icon button with red hover (deactivate)
- `brand` -- primary tinted action (activate, add account)
- `approve` -- green tinted action
- `deny` -- red tinted full button
- `ghost` -- secondary text button (cancel)
- `danger` -- red tinted full button (sign out)

### Badge colors
`surface` | `brand` | `amber` | `green` | `red` -- add `pill` prop for `rounded-full` count badges

### Complex widget behavior
For dialogs, popovers, dropdowns, tooltips: use Bits UI primitives (`bits-ui`).
They are headless -- apply Tailwind classes directly. AccountSwitcher shows the pattern.

### Brand palette
The brand colors are defined once as CSS custom properties in `src/app.css` (`--color-brand-primary` #4508BA, `--color-brand-secondary` #5F6BFF, `--color-brand-tertiary` #0DF7F0, plus light-theme variants). Do not duplicate hex values elsewhere.

## V1 Reference
React/TypeScript v1 is at `../privly/`. Use it to understand existing logic only -- do not copy React patterns. Translate to Svelte 5 equivalents.
