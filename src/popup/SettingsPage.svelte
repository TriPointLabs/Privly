<script lang="ts">
  import browser from 'webextension-polyfill';
  import { Button, Toggle } from './components/ui/index.js';
  import { ChevronLeft } from '@lucide/svelte';
  import { getExtensionSettings } from '../tools/db.js';
  import type { ExtensionSettingsRecord } from '../tools/db.js';
  import { isMessageOfType, MessageType, sendCommand } from '../types/messages.js';
  import { applyTheme, resolveTheme, cacheThemePreference, type ThemePreference } from './theme.js';

  let { onBack, onOpenDebug }: { onBack: () => void; onOpenDebug: () => void } = $props();

  let extensionSettings = $state<ExtensionSettingsRecord | null>(null);

  // CRITICAL: register listener synchronously before any await
  browser.runtime.onMessage.addListener((message) => {
    if (!isMessageOfType(MessageType.DB_CHANGED, message)) return;
    if (message.stores.includes('extension_settings')) refreshExtensionSettings();
  });

  async function refreshExtensionSettings() {
    extensionSettings = await getExtensionSettings();
  }

  async function init() {
    extensionSettings = await getExtensionSettings();
  }

  init();

  function sendExtensionSetting(patch: Partial<Omit<ExtensionSettingsRecord, 'id'>>) {
    sendCommand(MessageType.UPDATE_EXTENSION_SETTING, { patch }).catch(() => {});
  }

  function sendTestNotification() {
    sendCommand(MessageType.TEST_NOTIFICATION, {}).catch(() => {});
  }

</script>

<div class="flex flex-col h-full bg-surface-900">
  <!-- Header -->
  <div class="flex items-center justify-between px-4 h-12 border-b border-border-subtle shrink-0">
    <Button variant="icon-lg" onclick={onBack} aria-label="Back to main">
      <ChevronLeft class="w-4 h-4" aria-hidden="true" />
    </Button>
    <span class="text-sm font-semibold text-text-primary">Settings</span>
    <!-- Empty right slot for symmetry -->
    <div class="w-7"></div>
  </div>

  <!-- Scrollable content -->
  <div class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-6">

    {#if extensionSettings}
      <!-- Appearance section -->
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wide text-text-faint">Appearance</span>

        <div class="flex flex-col gap-0.5">
          <div class="flex items-center justify-between">
            <label for="select-theme" class="text-sm text-text-secondary">Theme</label>
            <select
              id="select-theme"
              class="bg-surface-700 text-text-secondary text-xs rounded px-2 py-1 border border-border-default focus:outline-none focus:ring-1 focus:ring-brand-secondary"
              value={extensionSettings.theme}
              onchange={(e) => {
                const val = (e.target as HTMLSelectElement).value as ThemePreference;
                sendExtensionSetting({ theme: val });
                cacheThemePreference(val);
                applyTheme(resolveTheme(val));
              }}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <p class="text-xs text-text-faint pr-10">Color theme for the extension popup.</p>
        </div>
      </div>

      <!-- Notifications section -->
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wide text-text-faint">Notifications</span>

        <div class="flex flex-col gap-0.5">
          <div class="flex items-center justify-between">
            <label for="toggle-show-notifications" class="text-sm text-text-secondary cursor-pointer">Show notifications</label>
            <Toggle
              id="toggle-show-notifications"
              checked={extensionSettings.showNotifications}
              onchange={(val) => sendExtensionSetting({ showNotifications: val })}
            />
          </div>
          <p class="text-xs text-text-faint pr-10">Show browser notifications for successful activation, new pending approvals, approval received, activation expiring soon, and activation expired.</p>
        </div>

        {#if extensionSettings.showNotifications}
          <div class="flex flex-col gap-0.5">
            <div class="flex items-center justify-between">
              <label for="select-notify-before" class="text-sm text-text-secondary">Notify before expiry</label>
              <select
                id="select-notify-before"
                class="bg-surface-700 text-text-secondary text-xs rounded px-2 py-1 border border-border-default focus:outline-none focus:ring-1 focus:ring-brand-secondary"
                value={extensionSettings.notifyMinutesBefore}
                onchange={(e) => {
                  const val = parseInt((e.target as HTMLSelectElement).value) as 5 | 10 | 15 | 30;
                  sendExtensionSetting({ notifyMinutesBefore: val });
                }}
              >
                <option value={5}>5 min</option>
                <option value={10}>10 min</option>
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
              </select>
            </div>
            <p class="text-xs text-text-faint pr-10">How early to send the "expiring soon" warning.</p>
          </div>
        {/if}

        <div class="flex flex-col gap-0.5">
          <Button
            variant="ghost"
            onclick={sendTestNotification}
            disabled={!extensionSettings.showNotifications}
            aria-label="Send a test browser notification"
          >
            Send test notification
          </Button>
          <p class="text-xs {extensionSettings.showNotifications ? 'text-text-faint' : 'text-text-ghost'} pr-10">
            {extensionSettings.showNotifications
              ? 'Sends a sample browser notification to confirm your system settings.'
              : 'Enable notifications above to send a test.'}
          </p>
        </div>
      </div>

      <!-- Extension Icon section -->
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wide text-text-faint">Extension Icon</span>

        <div class="flex flex-col gap-0.5">
          <div class="flex items-center justify-between">
            <label for="toggle-show-badge" class="text-sm text-text-secondary cursor-pointer">Show badge count</label>
            <Toggle
              id="toggle-show-badge"
              checked={extensionSettings.showBadge}
              onchange={(val) => sendExtensionSetting({ showBadge: val })}
            />
          </div>
          <p class="text-xs text-text-faint pr-10">Show the number of active role assignments on the extension icon.</p>
        </div>
      </div>

      <!-- Portal Reload section -->
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wide text-text-faint">Microsoft Portal Reload (Beta)</span>
        <p class="text-xs text-text-muted">Clears cookies and local storage for supported Microsoft portals (Azure Portal, Entra admin center, etc.) to force new tokens to be acquired after permission changes.</p>

        <div class="flex flex-col gap-0.5">
          <div class="flex items-center justify-between">
            <label for="toggle-reload-on-activation" class="text-sm text-text-secondary cursor-pointer">Reload on activation</label>
            <Toggle
              id="toggle-reload-on-activation"
              checked={extensionSettings.reloadPortalsOnActivation}
              onchange={(val) => sendExtensionSetting({ reloadPortalsOnActivation: val })}
            />
          </div>
        </div>

      </div>

      <!-- Debug -->
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wide text-text-faint">Debug</span>
        <div class="flex flex-col gap-0.5">
          <Button variant="ghost" onclick={onOpenDebug} aria-label="Open the debug panel">
            Open debug panel
          </Button>
          <p class="text-xs text-text-faint pr-10">Diagnostic log, current state, and entitlement map for troubleshooting.</p>
        </div>
      </div>
    {/if}

  </div>

  <!-- Support -->
  <div class="px-4 pt-2 pb-4 flex justify-center">
    <Button variant="ghost" onclick={() => window.open("https://support.tripointlabs.com")}>
      Support
    </Button>
  </div>
</div>
