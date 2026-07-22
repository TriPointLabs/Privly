<script lang="ts">
  import { Button } from './ui/index.js';
  import { TriangleAlert } from '@lucide/svelte';
  import type { AccountRecord } from '../../tools/db.js';

  let {
    account,
    onSignIn,
    onSignOut,
  }: { account: AccountRecord; onSignIn: () => void; onSignOut: () => void } = $props();
</script>

<div class="flex flex-col items-center justify-center h-full px-5 py-8 gap-5 text-center">

  <!-- Warning icon -->
  <div class="w-14 h-14 rounded-full bg-status-amber-muted flex items-center justify-center shrink-0">
    <TriangleAlert class="w-7 h-7 text-status-amber" aria-hidden="true" />
  </div>

  <!-- Heading + account info -->
  <div class="flex flex-col gap-1">
    <h2 class="text-base font-semibold text-text-primary">Attention Required</h2>
    <p class="text-sm font-medium text-text-secondary">{account.userPrincipalName}</p>
    <p class="text-xs text-text-faint">{account.tenantDisplayName ?? account.initialDomain ?? account.tenantDomain}</p>
  </div>

  <!-- Reason card -->
  {#if account.needsAttention}
    <div class="w-full rounded-lg bg-surface-700 border border-surface-600 px-4 py-3 text-sm text-text-tertiary text-left">
      {account.needsAttention.reason}
    </div>
  {/if}

  <!-- Actions -->
  <div class="flex flex-col gap-2 w-full">
    <Button variant="brand" onclick={onSignIn} aria-label="Sign in again as {account.displayName}">
      Sign In Again
    </Button>
    <Button variant="danger" onclick={onSignOut} aria-label="Sign out {account.displayName}">
      Sign Out
    </Button>
  </div>

</div>
