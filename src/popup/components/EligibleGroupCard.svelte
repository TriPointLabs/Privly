<script lang="ts">
  import type { EligibleGroup } from '../../types/pim';
  import { Badge, Button, Card, Spinner } from './ui/index.js';
  import { Users, Info } from '@lucide/svelte';

  let { group, isActivating = false, onInfo, onActivate }: { group: EligibleGroup; isActivating?: boolean; onInfo: () => void; onActivate: () => void } = $props();

  const iconColor = $derived(group.accessId === 'owner' ? 'text-status-amber' : 'text-text-muted');
</script>

<Card class="flex items-center justify-between hover:border-surface-500 transition-colors">
  <div class="flex items-center gap-2.5 min-w-0">
    <!-- Users icon: color encodes Owner (amber/gold) vs Member (neutral) -->
    <Users class="w-5 h-5 shrink-0 {iconColor}" aria-hidden="true" />
    <div class="flex flex-col min-w-0">
      <span class="text-sm text-text-primary truncate">{group.groupName}</span>
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="text-xs text-text-faint capitalize">{group.accessId}</span>
        {#if group.memberType}
          <Badge color="brand" pill class="shrink-0">{group.memberType}</Badge>
        {/if}
      </div>
    </div>
  </div>
  <div class="flex items-center gap-1.5 shrink-0 ml-2">
    {#if isActivating}
      <div class="flex items-center gap-1.5 text-xs text-text-faint pr-1" aria-live="polite">
        <Spinner class="w-3.5 h-3.5" />
        <span>Activating...</span>
      </div>
    {:else}
      <Button variant="icon" onclick={onInfo} aria-label="View details for {group.groupName}">
        <Info class="w-3.5 h-3.5" aria-hidden="true" />
      </Button>
      <Button variant="brand" onclick={onActivate} aria-label="Activate {group.groupName} ({group.accessId})">
        Activate
      </Button>
    {/if}
  </div>
</Card>
