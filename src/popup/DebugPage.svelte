<script lang="ts">
  /**
   * Standalone debug subview, reachable from anywhere (login page, settings,
   * and via settings from the needs-attention view) so diagnostics are
   * available even when no account is signed in or an account is broken.
   *
   * Shows logging controls, a per-account state snapshot, and the redacted
   * log viewer with level/category/text filtering across all accounts.
   */
  import browser from 'webextension-polyfill';
  import { Button, Toggle } from './components/ui/index.js';
  import { ChevronLeft, Search } from '@lucide/svelte';
  import { getExtensionSettings } from '../tools/db.js';
  import type { ExtensionSettingsRecord, LogRecord } from '../tools/db.js';
  import { isMessageOfType, MessageType, sendCommand } from '../types/messages.js';
  import { loadLogs, loadDebugSnapshot, loadEntitlementTree, type DebugSnapshot, type AccountEntitlements, type EntitlementNode } from './data.js';

  let { onBack }: { onBack: () => void } = $props();

  let extensionSettings = $state<ExtensionSettingsRecord | null>(null);
  let snapshot = $state<DebugSnapshot | null>(null);
  let entitlements = $state<AccountEntitlements[]>([]);
  let logs = $state<LogRecord[]>([]);
  let logLevelFilter = $state<'all' | 'info' | 'warn' | 'error'>('all');
  let logCategoryFilter = $state('all');
  let logSearch = $state('');

  // CRITICAL: register listener synchronously before any await
  browser.runtime.onMessage.addListener((message) => {
    if (!isMessageOfType(MessageType.DB_CHANGED, message)) return;
    if (message.stores.includes('extension_settings')) refreshSettings();
  });

  async function refreshSettings() {
    extensionSettings = await getExtensionSettings();
  }

  async function refreshDebug() {
    [snapshot, entitlements, logs] = await Promise.all([loadDebugSnapshot(), loadEntitlementTree(), loadLogs()]);
  }

  refreshSettings();
  refreshDebug();

  const logCategories = $derived([...new Set(logs.map(l => l.category))].sort());
  const filteredLogs = $derived(logs.filter(l =>
    (logLevelFilter === 'all' || l.level === logLevelFilter) &&
    (logCategoryFilter === 'all' || l.category === logCategoryFilter) &&
    (logSearch.trim() === '' || l.message.toLowerCase().includes(logSearch.trim().toLowerCase()))
  ));

  function sendExtensionSetting(patch: Partial<Omit<ExtensionSettingsRecord, 'id'>>) {
    sendCommand(MessageType.UPDATE_EXTENSION_SETTING, { patch }).catch(() => {});
  }

  /** Formats an epoch as a short relative label like "in 43m" or "12m ago". */
  function relTime(epochMs: number | null): string {
    if (!epochMs) return 'n/a';
    const diff = epochMs - Date.now();
    const abs = Math.abs(diff);
    const label = abs >= 3_600_000 ? `${Math.round(abs / 3_600_000)}h` : abs >= 60_000 ? `${Math.round(abs / 60_000)}m` : `${Math.round(abs / 1000)}s`;
    return diff >= 0 ? `in ${label}` : `${label} ago`;
  }

  /** Copies the filtered log view as plain text. Entries are already redacted at write time. */
  async function copyLogs() {
    const text = filteredLogs
      .map(l => `[${new Date(l.timestamp).toISOString()}] ${l.level.toUpperCase()} ${l.category}: ${l.message}`)
      .join('\n');
    await navigator.clipboard.writeText(text).catch(() => {});
  }

  async function handleClearLogs() {
    await sendCommand(MessageType.CLEAR_LOGS, {});
    await refreshDebug();
  }

  function setLoggingEnabled(val: boolean) {
    sendExtensionSetting({ loggingEnabled: val });
    // The service worker clears the store when disabling; reflect that immediately.
    if (!val) logs = [];
  }

  /** Renders one entitlement tree as indented ASCII for the copy export. */
  function treeToAscii(node: EntitlementNode, prefix: string, isLast: boolean): string {
    const branch = prefix === '' ? '' : `${prefix}${isLast ? '\u2514\u2500 ' : '\u251c\u2500 '}`;
    const childPrefix = prefix === '' ? '' : `${prefix}${isLast ? '   ' : '\u2502  '}`;
    const line = `${branch}${node.label}${node.detail ? `  ${node.detail}` : ''}`;
    const kids = node.children ?? [];
    const childLines = kids.map((c, i) => treeToAscii(c, childPrefix || '', i === kids.length - 1));
    return [line, ...childLines].join('\n');
  }

  async function copyEntitlements() {
    const text = entitlements
      .map(a => [`Account: ${a.accountLabel}`, ...a.sections.map((s, i) => treeToAscii(s, ' ', i === a.sections.length - 1))].join('\n'))
      .join('\n\n');
    await navigator.clipboard.writeText(text).catch(() => {});
  }
</script>

{#snippet treeNode(node: EntitlementNode, depth: number)}
  <div class="flex items-baseline gap-2 py-0.5" style="padding-left: {depth * 14}px">
    <span class={node.status === 'scope' ? 'text-text-secondary font-medium shrink-0' : 'text-text-primary shrink-0'}>{node.label}</span>
    {#if node.detail}
      <span class={node.status === 'missing-policy' ? 'text-status-amber' : node.status === 'active' ? 'text-status-green' : 'text-text-faint'}>{node.detail}</span>
    {/if}
  </div>
  {#each node.children ?? [] as child, i (i)}
    {@render treeNode(child, depth + 1)}
  {/each}
{/snippet}

<div class="flex flex-col h-full bg-surface-900">
  <!-- Header -->
  <div class="flex items-center justify-between px-4 h-12 border-b border-border-subtle shrink-0">
    <Button variant="icon-lg" onclick={onBack} aria-label="Back">
      <ChevronLeft class="w-4 h-4" aria-hidden="true" />
    </Button>
    <span class="text-sm font-semibold text-text-primary">Debug</span>
    <!-- Empty right slot for symmetry -->
    <div class="w-7"></div>
  </div>

  <!-- Scrollable content -->
  <div class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5">

    {#if extensionSettings}
      <!-- Logging controls -->
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wide text-text-faint">Logging</span>

        <div class="flex flex-col gap-0.5">
          <div class="flex items-center justify-between">
            <label for="toggle-logging" class="text-sm text-text-secondary cursor-pointer">Diagnostic logging</label>
            <Toggle
              id="toggle-logging"
              checked={extensionSettings.loggingEnabled}
              onchange={setLoggingEnabled}
            />
          </div>
          <p class="text-xs text-text-faint pr-10">Keeps a local, privacy-redacted activity log for troubleshooting. Turning this off clears the log.</p>
        </div>

        {#if extensionSettings.loggingEnabled}
          <div class="flex flex-col gap-0.5">
            <div class="flex items-center justify-between">
              <label for="select-log-max" class="text-sm text-text-secondary">Log size</label>
              <select
                id="select-log-max"
                class="bg-surface-700 text-text-secondary text-xs rounded px-2 py-1 border border-border-default focus:outline-none focus:ring-1 focus:ring-brand-secondary"
                value={extensionSettings.logMaxEntries}
                onchange={(e) => sendExtensionSetting({ logMaxEntries: parseInt((e.target as HTMLSelectElement).value) })}
              >
                <option value={500}>500 entries</option>
                <option value={2000}>2,000 entries</option>
                <option value={10000}>10,000 entries</option>
              </select>
            </div>
            <p class="text-xs text-text-faint pr-10">Older entries are discarded beyond this limit. Increase for large environments.</p>
          </div>
        {/if}
      </div>
    {/if}

    <!-- State snapshot -->
    {#if snapshot}
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wide text-text-faint">Current state</span>
          <Button variant="ghost" onclick={refreshDebug} aria-label="Refresh debug information">Refresh</Button>
        </div>
        <div class="rounded-lg bg-surface-800 border border-surface-700 p-2.5 text-xs text-text-muted flex flex-col gap-1">
          <span>Version {snapshot.extensionVersion} · DB v{snapshot.dbVersion} · {snapshot.logCount} log entries</span>
          <span>Last sync: {snapshot.lastSyncAt ? relTime(snapshot.lastSyncAt) : 'not recorded'}</span>
          <span>Alarms: {snapshot.alarms.length === 0 ? 'none' : snapshot.alarms.map(a => `${a.name} (${relTime(a.scheduledTime)})`).join(', ')}</span>
          {#if snapshot.accounts.length === 0}
            <span class="pt-1 border-t border-surface-700">No accounts signed in.</span>
          {/if}
          {#each snapshot.accounts as acct (acct.label)}
            <div class="pt-1 border-t border-surface-700 flex flex-col gap-0.5">
              <span class="text-text-secondary">{acct.label}</span>
              <span>Graph token {relTime(acct.graphTokenExpiresAt)} · ARM token {relTime(acct.armTokenExpiresAt)}</span>
              <span>{Object.entries(acct.counts).filter(([, n]) => n > 0).map(([s, n]) => `${s}: ${n}`).join(' · ') || 'no records'}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Entitlement map -->
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between">
        <span class="text-xs font-semibold uppercase tracking-wide text-text-faint">Entitlement map</span>
        {#if entitlements.some(a => a.sections.length > 0)}
          <Button variant="ghost" onclick={copyEntitlements} aria-label="Copy the entitlement map as text">Copy</Button>
        {/if}
      </div>
      <div class="rounded-lg bg-surface-800 border border-surface-700 p-2.5 text-[11px] leading-snug max-h-64 overflow-y-auto" role="tree" aria-label="Entitlement map by account">
        {#if entitlements.length === 0}
          <p class="text-text-faint text-xs">No accounts signed in.</p>
        {:else}
          {#each entitlements as acct, ai (acct.accountLabel)}
            <div class={ai > 0 ? 'pt-2 mt-2 border-t border-surface-700' : ''}>
              <span class="text-text-secondary font-semibold">{acct.accountLabel}</span>
              {#if acct.sections.length === 0}
                <p class="text-text-faint">No cached entitlements.</p>
              {:else}
                {#each acct.sections as section, i (i)}
                  {@render treeNode(section, 0)}
                {/each}
              {/if}
            </div>
          {/each}
        {/if}
      </div>
      <p class="text-xs text-text-faint">Amber rows mean no policy is cached and the UI is showing default constraints.</p>
    </div>

    <!-- Log viewer -->
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold uppercase tracking-wide text-text-faint">Log</span>
        <div class="flex items-center gap-1.5">
          <select
            aria-label="Filter log by level"
            class="bg-surface-700 text-text-secondary text-xs rounded px-1.5 py-1 border border-border-default focus:outline-none focus:ring-1 focus:ring-brand-secondary"
            bind:value={logLevelFilter}
          >
            <option value="all">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <select
            aria-label="Filter log by category"
            class="bg-surface-700 text-text-secondary text-xs rounded px-1.5 py-1 border border-border-default focus:outline-none focus:ring-1 focus:ring-brand-secondary"
            bind:value={logCategoryFilter}
          >
            <option value="all">All categories</option>
            {#each logCategories as cat (cat)}
              <option value={cat}>{cat}</option>
            {/each}
          </select>
        </div>
      </div>
      <!-- Text search: with multiple accounts, typing a masked UPN (e.g. "d***") isolates one account's entries -->
      <div class="relative">
        <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-disabled pointer-events-none" aria-hidden="true" />
        <input
          type="text"
          bind:value={logSearch}
          placeholder="Search log (e.g. a masked account, role name, HTTP status)..."
          aria-label="Search log entries"
          class="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface-800 border border-surface-600 text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-brand-secondary"
        />
      </div>
      <div class="rounded-lg bg-surface-800 border border-surface-700 max-h-64 overflow-y-auto font-mono text-[10px] leading-snug" role="log" aria-label="Diagnostic log entries">
        {#if filteredLogs.length === 0}
          <p class="p-2.5 text-text-faint font-sans text-xs">No log entries.</p>
        {:else}
          {#each filteredLogs as entry (entry.id)}
            <div class="px-2.5 py-1 border-b border-surface-700/60 last:border-b-0">
              <span class="text-text-disabled">{new Date(entry.timestamp).toLocaleTimeString()}</span>
              <span class={entry.level === 'error' ? 'text-status-red' : entry.level === 'warn' ? 'text-status-amber' : 'text-text-faint'}> {entry.level.toUpperCase()}</span>
              <span class="text-text-disabled"> [{entry.category}]</span>
              <span class="text-text-secondary"> {entry.message}</span>
            </div>
          {/each}
        {/if}
      </div>
      <div class="flex items-center gap-2">
        <Button variant="ghost" onclick={copyLogs} aria-label="Copy filtered log entries to clipboard">Copy</Button>
        <Button variant="ghost" onclick={handleClearLogs} aria-label="Clear all log entries">Clear</Button>
      </div>
    </div>

  </div>
</div>
