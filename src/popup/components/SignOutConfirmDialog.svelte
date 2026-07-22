<script lang="ts">
  /**
   * Confirmation dialog shown before signing out an account.
   * Displays the account avatar and identity so the user can verify they are
   * removing the intended account before committing.
   */
  import { Dialog } from "bits-ui";
  import { Button, Avatar } from './ui/index.js';
  import { X } from '@lucide/svelte';
  import type { AccountRecord } from '../../tools/db.js';

  let { open = $bindable(false), account, onConfirm }: {
    open: boolean;
    account: AccountRecord | null;
    onConfirm: (accountId: string) => void;
  } = $props();

  function handleConfirm() {
    if (!account) return;
    onConfirm(account.id);
    open = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 bg-overlay-heavy z-50 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
      aria-hidden="true"
    />
    <Dialog.Content
      aria-labelledby="signout-dialog-title"
      aria-describedby="signout-dialog-desc"
      class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-80 bg-surface-800 rounded-xl border border-surface-600 flex flex-col shadow-2xl z-[60] focus:outline-none data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-surface-600">
        <span id="signout-dialog-title" class="text-sm font-semibold text-text-primary">Sign Out</span>
        <Button variant="icon" onclick={() => (open = false)} aria-label="Cancel sign out">
          <X class="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>

      <!-- Body -->
      {#if account}
        <div class="flex flex-col items-center gap-4 px-5 py-5 text-center">
          <Avatar
            displayName={account.displayName}
            photoDataUrl={account.photoDataUrl}
            cloud={account.cloud}
            size="lg"
          />
          <div class="flex flex-col gap-0.5">
            <p class="text-sm font-medium text-text-primary">{account.displayName}</p>
            <p class="text-xs text-text-muted">{account.userPrincipalName}</p>
            <p class="text-[10px] text-text-disabled">{account.tenantDisplayName ?? account.initialDomain ?? account.tenantDomain}</p>
          </div>
          <p id="signout-dialog-desc" class="text-xs text-text-muted leading-relaxed">
            This will remove the account and all associated data from this device.
          </p>
        </div>
      {/if}

      <!-- Footer -->
      <div class="flex gap-2 px-5 py-4 border-t border-surface-600">
        <Button
          variant="danger"
          class="flex-1"
          onclick={handleConfirm}
          aria-label="Confirm sign out{account ? ` of ${account.displayName}` : ''}"
        >
          Sign Out
        </Button>
        <Button variant="ghost" class="flex-1" onclick={() => (open = false)}>
          Cancel
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
