<script lang="ts">
  import type { ActiveRoleAssignment, ActiveGroupAssignment } from '../../types/pim';
  import { formatScopeLabel } from '../../tools/scopeParser.js';
  import { formatRemaining } from '../utils/duration.js';
  import { Button, Card, Spinner } from './ui/index.js';
  import { Info, X } from '@lucide/svelte';

  let { assignment, onInfo, onDeactivate }: {
    assignment: ActiveRoleAssignment | ActiveGroupAssignment;
    onInfo: () => void;
    onDeactivate: (id: string) => Promise<void>;
  } = $props();

  const displayName = $derived(
    'roleName' in assignment ? assignment.roleName : `${assignment.groupName} (${assignment.accessId})`
  );

  const isPermanent = $derived('isPermanent' in assignment && assignment.isPermanent === true);

  // A Group- or Inherited-derived assignment has no self-owned activation here, so SelfDeactivate
  // would fail. Treat those like permanent assignments: disable the button with an explanatory label.
  const cannotDeactivate = $derived(
    isPermanent || (assignment.memberType != null && assignment.memberType !== 'Direct')
  );
  const deactivateLabel = $derived(
    isPermanent ? 'Permanent assignment -- cannot be deactivated via Privly' :
    assignment.memberType === 'Group' ? `Held via group membership -- deactivate ${displayName} at the source` :
    assignment.memberType === 'Inherited' ? 'Inherited from a parent scope -- cannot be deactivated via Privly' :
    `Deactivate ${displayName}`
  );

  function getRemainingMs(): number {
    return Math.max(0, assignment.expiresAt.getTime() - Date.now());
  }

  let remainingMs = $state(getRemainingMs());
  let deactivating = $state(false);

  $effect(() => {
    if (isPermanent) return;
    const interval = setInterval(() => {
      remainingMs = getRemainingMs();
    }, 10_000);
    return () => clearInterval(interval);
  });

  // Total activation duration in ms. Derived from startedAt → expiresAt when available (accurate
  // regardless of what fraction of the policy maximum the user requested). Falls back to 8h for
  // records written before startedAt was stored, which will self-correct on the next server sync.
  const totalMs = $derived(
    isPermanent ? 1 :
    assignment.startedAt
      ? assignment.expiresAt.getTime() - assignment.startedAt.getTime()
      : 8 * 60 * 60 * 1000
  );
  let progressPct = $derived(isPermanent ? 100 : Math.max(0, Math.min(100, (remainingMs / totalMs) * 100)));
  let timeLabel = $derived(isPermanent ? '∞' : formatRemaining(remainingMs));

  async function handleDeactivate() {
    deactivating = true;
    await onDeactivate(assignment.id);
    // On success the component unmounts when the parent removes it from the array.
    // On failure the component stays mounted, so reset the spinner.
    deactivating = false;
  }
</script>

<Card class="flex flex-col gap-2">
  <div class="flex items-center justify-between">
    <div class="flex flex-col min-w-0 flex-1">
      <span class="text-sm text-text-primary truncate">{displayName}</span>
      {#if 'scope' in assignment && assignment.scope}
        <span class="text-xs text-text-disabled truncate">{formatScopeLabel(assignment.scope)}</span>
      {/if}
    </div>
    <div class="flex items-center gap-1.5 shrink-0 ml-2">
      <span
        class="text-xs font-mono {isPermanent ? 'text-text-disabled' : 'text-brand-tertiary'}"
        aria-live={isPermanent ? undefined : 'polite'}
      >{timeLabel}</span>
      <Button variant="icon" onclick={onInfo} disabled={deactivating} aria-label="View details for {displayName}">
        <Info class="w-3.5 h-3.5" aria-hidden="true" />
      </Button>
      <Button
        variant={cannotDeactivate ? 'icon' : 'icon-danger'}
        onclick={cannotDeactivate ? undefined : handleDeactivate}
        disabled={deactivating || cannotDeactivate}
        aria-label={deactivateLabel}
      >
        {#if deactivating}
          <Spinner />
        {:else}
          <X class="w-3.5 h-3.5 {cannotDeactivate ? 'text-text-ghost' : ''}" aria-hidden="true" />
        {/if}
      </Button>
    </div>
  </div>
  <!-- Progress bar -->
  <div
    role="progressbar"
    aria-label="{isPermanent ? 'Permanent assignment' : 'Time remaining'} for {displayName}"
    aria-valuenow={Math.round(progressPct)}
    aria-valuemin={0}
    aria-valuemax={100}
    class="h-1.5 rounded-full bg-surface-600 overflow-hidden"
  >
    <div
      class="h-full rounded-full transition-all duration-1000 {isPermanent ? 'bg-border-default' : 'bg-linear-to-r from-brand-primary to-brand-secondary'}"
      style="width: {progressPct}%"
    ></div>
  </div>
</Card>
