<script lang="ts">
  import type { EligibleRole } from '../../types/pim';
  import { formatScopeLabel } from '../../tools/scopeParser.js';
  import { Badge, Button, Card, Spinner } from './ui/index.js';
  import { KeyRound, Info } from '@lucide/svelte';

  let { role, isActivating = false, onInfo, onActivate }: { role: EligibleRole; isActivating?: boolean; onInfo: () => void; onActivate: () => void } = $props();

  const iconColor = $derived(role.roleType === 'EntraRole' ? 'text-brand-secondary' : 'text-brand-tertiary');
</script>

<Card class="flex items-center justify-between hover:border-surface-500 transition-colors">
  <div class="flex items-center gap-2.5 min-w-0">
    <!-- Key icon: color encodes Entra (blue) vs Azure (teal) -->
    <KeyRound class="w-5 h-5 shrink-0 {iconColor}" aria-hidden="true" />
    <div class="flex flex-col min-w-0">
      <span class="text-sm text-text-primary truncate">{role.roleName}</span>
      {#if role.memberType}
        <div class="flex items-center gap-1.5 min-w-0">
          <Badge color="brand" pill class="shrink-0">{role.memberType}</Badge>
        </div>
      {/if}
      {#if role.scope}
        <span class="text-xs text-text-disabled truncate">{formatScopeLabel(role.scope)}</span>
      {/if}
    </div>
  </div>
  <div class="flex items-center gap-1.5 shrink-0 ml-2">
    {#if isActivating}
      <div class="flex items-center gap-1.5 text-xs text-text-faint pr-1" aria-live="polite">
        <Spinner class="w-3.5 h-3.5" />
        <span>Activating...</span>
      </div>
    {:else}
      <Button variant="icon" onclick={onInfo} aria-label="View details for {role.roleName}">
        <Info class="w-3.5 h-3.5" aria-hidden="true" />
      </Button>
      <Button variant="brand" onclick={onActivate} aria-label="Activate {role.roleName}">
        Activate
      </Button>
    {/if}
  </div>
</Card>
