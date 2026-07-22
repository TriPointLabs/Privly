<script lang="ts">
  /**
   * Slide-in panel (Bits UI Dialog) that lists all signed-in accounts and
   * allows switching between them, adding a new account, or signing out.
   *
   * Accounts are sorted by tenant domain then display name so the list order
   * is stable across refreshes.
   */
  import { Dialog } from 'bits-ui';
  import { Button, Avatar } from './ui/index.js';
  import { X, Check, AlertCircle } from '@lucide/svelte';
  import type { CloudType } from '../../tools/db.js';

  type Account = {
    id: string;
    displayName: string;
    userPrincipalName: string;
    tenantDomain: string;
    initialDomain: string | null;
    tenantDisplayName: string | null;
    cloud: CloudType;
    photoDataUrl: string | null;
    needsAttention: { reason: string } | null;
  };

  let { open = $bindable(false), accounts, activeAccountId, onSelect, onAddAccount, onSignOut }: {
    open: boolean;
    accounts: Account[];
    activeAccountId: string | null;
    onSelect: (id: string) => void;
    onAddAccount: () => void;
    onSignOut: () => void;
  } = $props();

  /**
   * Accounts sorted by `initialDomain ?? tenantDomain` (ascending) then
   * `displayName` (locale-aware ascending).
   */
  const sortedAccounts = $derived(
    [...accounts].sort((a, b) => {
      const domainA = (a.initialDomain ?? a.tenantDomain).toLowerCase();
      const domainB = (b.initialDomain ?? b.tenantDomain).toLowerCase();
      if (domainA !== domainB) return domainA < domainB ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    })
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 bg-overlay z-40 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" aria-hidden="true" />
    <Dialog.Content
      aria-labelledby="acct-switcher-title"
      class="fixed right-0 top-0 h-full w-72 bg-surface-800 border-l border-surface-600 flex flex-col shadow-2xl z-50 focus:outline-none data-[state=open]:animate-slide-in-from-right data-[state=closed]:animate-slide-out-to-right"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3 border-b border-surface-600">
        <span id="acct-switcher-title" class="text-sm font-semibold text-text-primary">Accounts</span>
        <Button variant="icon" onclick={() => (open = false)} aria-label="Close account switcher">
          <X class="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>

      <!-- Account list -->
      <div class="flex-1 overflow-y-auto py-2">
        {#each sortedAccounts as account (account.id)}
          {@const isActive = account.id === activeAccountId}
          <button
            type="button"
            onclick={() => onSelect(account.id)}
            aria-current={isActive ? 'true' : undefined}
            class="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors
              {isActive
                ? 'bg-brand-primary/20 border-l-2 border-brand-primary'
                : 'hover:bg-surface-700 border-l-2 border-transparent'}"
          >
            <Avatar
              displayName={account.displayName}
              photoDataUrl={account.photoDataUrl}
              cloud={account.cloud}
              size="md"
            />
            <div class="flex-1 min-w-0">
              <div class="text-sm text-text-primary truncate">{account.displayName}</div>
              <div class="text-xs text-text-muted truncate">{account.userPrincipalName}</div>
              <div class="text-[10px] text-text-disabled truncate" title="{account.initialDomain}">{account.tenantDisplayName ?? account.initialDomain ?? account.tenantDomain}</div>
            </div>
            {#if account.needsAttention}
              <AlertCircle class="w-4 h-4 text-status-red shrink-0" aria-label="Needs attention: {account.needsAttention.reason}" />
            {:else if isActive}
              <Check class="w-4 h-4 text-brand-secondary shrink-0" aria-hidden="true" />
            {/if}
          </button>
        {/each}
      </div>

      <!-- Footer -->
      <div class="flex flex-col gap-2 px-4 py-3 border-t border-surface-600">
        <Button variant="brand" class="w-full" onclick={onAddAccount}>
          + Add Account
        </Button>
        <Button variant="danger" class="w-full" onclick={onSignOut} aria-label="Sign out current account">
          Sign Out
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
