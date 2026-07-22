<script lang="ts">
  /**
   * Read-only detail view for any of the four DetailTarget kinds
   * (eligible/active x role/group). All display fields are derived by
   * narrowing the discriminated union; the countdown interval only runs for
   * active, non-permanent targets. Rendered full-screen over MainPage rather
   * than as a modal so the popup keeps a single scroll context.
   */
  import type { DetailTarget } from '../../types/pim';
  import { Dialog } from "bits-ui";
  import { Button, Badge, Card } from './ui/index.js';
  import { ChevronLeft, Copy } from '@lucide/svelte';
  import { formatDuration, formatRemaining } from '../utils/duration.js';

  function scopeKindLabel(kind: string): string {
    switch (kind) {
      case 'managementGroup': return 'Management Group';
      case 'subscription': return 'Subscription';
      case 'resourceGroup': return 'Resource Group';
      case 'resource': return 'Resource';
      default: return kind;
    }
  }

  let { target, onBack }: { target: DetailTarget; onBack: () => void } = $props();

  function getRemainingSeconds(expiresAt: Date): number {
    return Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  }

  const isActive = $derived(target.kind === 'active-role' || target.kind === 'active-group');
  const isGroup = $derived(target.kind === 'eligible-group' || target.kind === 'active-group');

  const pageTitle = $derived(isGroup ? 'Group Details' : 'Role Details');

  const displayName = $derived(
    target.kind === 'eligible-role' ? target.data.roleName :
    target.kind === 'eligible-group' ? target.data.groupName :
    target.kind === 'active-role' ? target.data.roleName :
    target.data.groupName
  );

  const policyRules = $derived(target.data.policyRules);

  const includedRoles = $derived(
    target.kind === 'eligible-group' || target.kind === 'active-group'
      ? target.data.includedRoles
      : null
  );

  const expiresAt = $derived(
    target.kind === 'active-role' || target.kind === 'active-group'
      ? target.data.expiresAt
      : null
  );

  const isPermanent = $derived(
    target.kind === 'active-role' && target.data.isPermanent === true
  );

  let remainingSeconds = $state(0);

  $effect(() => {
    if (!expiresAt || isPermanent) {
      remainingSeconds = 0;
      return;
    }
    remainingSeconds = getRemainingSeconds(expiresAt);
    const interval = setInterval(() => {
      remainingSeconds = getRemainingSeconds(expiresAt);
    }, 10_000);
    return () => clearInterval(interval);
  });
</script>

<div class="flex flex-col h-full bg-surface-900 text-text-primary">
  <!-- Header -->
  <header class="flex items-center gap-3 px-4 h-12 bg-surface-800 border-b border-surface-700 shrink-0">
    <Button variant="icon" onclick={onBack} aria-label="Back">
      <ChevronLeft class="w-4 h-4" aria-hidden="true" />
    </Button>
    <h1 class="text-sm font-semibold text-text-primary">{pageTitle}</h1>
  </header>

  <!-- Scrollable content -->
  <div class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5">

    <!-- Name + badges -->
    <div class="flex flex-col gap-2">
      <h2 class="text-base font-semibold text-text-primary">{displayName}</h2>
      <div class="flex flex-wrap gap-1.5">
        {#if target.kind === 'eligible-role' || target.kind === 'active-role'}
          <Badge color="surface">{target.data.roleType === 'EntraRole' ? 'Entra Role' : 'Azure Role'}</Badge>
          <Badge color="surface">{target.data.isBuiltIn ? 'Built-in' : 'Custom'}</Badge>
        {/if}
        {#if target.kind === 'eligible-group' || target.kind === 'active-group'}
          <Badge color="surface"><span class="capitalize">{target.data.accessId}</span></Badge>
        {/if}
        {#if isActive}
          <Badge color="brand">Active</Badge>
        {/if}
      </div>
    </div>

    <!-- Scope (Azure roles only) -->
    {#if (target.kind === 'eligible-role' || target.kind === 'active-role') && target.data.roleType === 'AzureRole' && target.data.scope}
      {@const scope = target.data.scope}
      <div class="flex flex-col gap-2">
        <h3 class="text-[10px] font-semibold text-text-faint uppercase tracking-wider">Scope</h3>
        <div class="flex flex-col rounded-lg overflow-hidden border border-surface-600 divide-y divide-surface-700">
          <div class="detail-row">
            <span class="text-xs text-text-tertiary">Type</span>
            <span class="text-xs text-text-primary font-medium">{scopeKindLabel(scope.kind)}</span>
          </div>
          {#if scope.managementGroupId}
            <div class="detail-row items-start">
              <span class="text-xs text-text-tertiary shrink-0">Management group</span>
              <div class="flex flex-col items-end ml-4">
                <span class="text-xs text-text-primary font-medium">{scope.displayName}</span>
                <span class="text-xs text-text-muted font-mono">{scope.managementGroupId}</span>
              </div>
            </div>
          {/if}
          {#if scope.subscriptionId}
            <div class="detail-row items-start">
              <span class="text-xs text-text-tertiary shrink-0">Subscription</span>
              <div class="flex flex-col items-end ml-4">
                {#if scope.subscriptionName}
                  <span class="text-xs text-text-primary font-medium">{scope.subscriptionName}</span>
                {/if}
                <span class="text-xs text-text-muted font-mono">{scope.subscriptionId}</span>
              </div>
            </div>
          {/if}
          {#if scope.resourceGroupName}
            <div class="detail-row">
              <span class="text-xs text-text-tertiary">Resource group</span>
              <span class="text-xs text-text-primary font-medium">{scope.resourceGroupName}</span>
            </div>
          {/if}
          {#if scope.kind === 'resource' && scope.resourceProvider}
            <div class="detail-row">
              <span class="text-xs text-text-tertiary">Resource type</span>
              <span class="text-xs text-text-primary font-medium">{scope.resourceProvider}/{scope.resourceType}</span>
            </div>
            <div class="detail-row">
              <span class="text-xs text-text-tertiary">Resource</span>
              <span class="text-xs text-text-primary font-medium">{scope.resourceName}</span>
            </div>
          {/if}
          <div class="detail-row gap-2">
            <span class="text-xs text-text-tertiary shrink-0">Scope</span>
            <span class="text-xs text-text-disabled truncate font-mono flex-1 min-w-0">{scope.rawScope}</span>
            <button
              type="button"
              onclick={() => navigator.clipboard.writeText(scope.rawScope)}
              aria-label="Copy scope to clipboard"
              class="shrink-0 p-1 rounded text-text-disabled hover:text-text-tertiary hover:bg-surface-700 transition-colors"
            >
              <Copy class="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Current activation (active only) -->
    {#if isActive && expiresAt}
      <div class="flex flex-col gap-2">
        <h3 class="text-[10px] font-semibold text-text-faint uppercase tracking-wider">Current Activation</h3>
        <Card class="flex justify-between items-center">
          <span class="text-xs text-text-tertiary">Expires in</span>
          {#if isPermanent}
            <span class="text-xs font-mono text-text-disabled">Never</span>
          {:else}
            <span class="text-xs font-mono text-brand-tertiary" aria-live="polite">{formatRemaining(remainingSeconds * 1000)}</span>
          {/if}
        </Card>
      </div>
    {/if}

    <!-- Activation policy -->
    <div class="flex flex-col gap-2">
      <h3 class="text-[10px] font-semibold text-text-faint uppercase tracking-wider">Activation Policy</h3>
      <div class="flex flex-col rounded-lg overflow-hidden border border-surface-600 divide-y divide-surface-700">
        <div class="detail-row">
          <span class="text-xs text-text-tertiary">Max Duration</span>
          <span class="text-xs text-text-primary font-medium">{formatDuration(policyRules.maximumDuration)}</span>
        </div>
        <div class="detail-row">
          <span class="text-xs text-text-tertiary">MFA</span>
          {#if policyRules.mfaRequired}
            <span class="text-xs text-status-amber font-medium">Required</span>
          {:else}
            <span class="text-xs text-text-disabled">Not required</span>
          {/if}
        </div>
        <div class="detail-row">
          <span class="text-xs text-text-tertiary">Justification</span>
          {#if policyRules.justificationRequired}
            <span class="text-xs text-status-amber font-medium">Required</span>
          {:else}
            <span class="text-xs text-text-disabled">Not required</span>
          {/if}
        </div>
        <div class="detail-row">
          <span class="text-xs text-text-tertiary">Ticketing</span>
          {#if policyRules.ticketingRequired}
            <span class="text-xs text-status-amber font-medium">Required</span>
          {:else}
            <span class="text-xs text-text-disabled">Not required</span>
          {/if}
        </div>
        <div class="detail-row">
          <span class="text-xs text-text-tertiary">Approval</span>
          {#if policyRules.approvalRequired}
            <span class="text-xs text-status-red font-medium">Required</span>
          {:else}
            <span class="text-xs text-text-disabled">Not required</span>
          {/if}
        </div>
        <div class="detail-row">
          <span class="text-xs text-text-tertiary">Auth Context</span>
          {#if policyRules.authContextRequired}
            <span class="text-xs text-status-amber font-medium">{policyRules.authContextClassRef}</span>
          {:else}
            <span class="text-xs text-text-disabled">Not required</span>
          {/if}
        </div>
      </div>
    </div>

    <!-- Included roles (groups only) -->
    {#if includedRoles && includedRoles.length > 0}
      <div class="flex flex-col gap-2">
        <h3 class="text-[10px] font-semibold text-text-faint uppercase tracking-wider">Included Roles</h3>
        <div class="flex flex-col rounded-lg overflow-hidden border border-surface-600 divide-y divide-surface-700">
          {#each includedRoles as role (role.id)}
            <div class="detail-row">
              <span class="text-xs text-text-primary truncate">{role.displayName}</span>
              <span class="ml-2 shrink-0">
                <Badge color="surface">{role.roleType === 'EntraRole' ? 'Entra' : 'Azure'}</Badge>
              </span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

  </div>
</div>
