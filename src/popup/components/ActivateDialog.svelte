<script lang="ts">
  /**
   * Activation request dialog for eligible roles and groups. The target's
   * cached policy drives everything: the duration slider is capped at the
   * policy maximum, justification/ticket fields only block submission when
   * the policy requires them, and initial focus lands on the first required
   * field. Approval-required outcomes are handled by the caller via the ack.
   */
  import { Dialog } from "bits-ui";
  import { Button, Badge, Input, Textarea, Spinner, Toggle } from './ui/index.js';
  import { X } from '@lucide/svelte';
  import type { EligibleRole, EligibleGroup } from '../../types/pim.js';
  import { toMinutes, minutesToIso, formatMinutes } from '../utils/duration.js';
  import { getExtensionSettings } from '../../tools/db.js';
  import { MessageType, sendCommand } from '../../types/messages.js';

  export type ActivationParams = {
    id: string;
    kind: 'role' | 'group';
    duration: string;
    justification?: string;
    ticket?: string;
    ticketSystem?: string;
  };

  let { open = $bindable(false), target, onConfirm }: {
    open: boolean;
    target: { kind: 'role'; data: EligibleRole } | { kind: 'group'; data: EligibleGroup } | null;
    onConfirm: (params: ActivationParams) => Promise<void>;
  } = $props();

  // Capped at 1440 because minutesToIso tops out at P1D; policies allowing
  // longer activations still submit at most one day from this dialog.
  const maxMinutes = $derived(
    target ? Math.min(toMinutes(target.data.policyRules.maximumDuration), 1440) : 480
  );

  let durationMinutes = $state(480);
  let justification = $state('');
  let ticket = $state('');
  let submitting = $state(false);
  let reloadPortals = $state(true);

  // Reset form when target changes
  $effect(() => {
    if (target) {
      durationMinutes = Math.min(toMinutes(target.data.policyRules.maximumDuration), 1440);
      justification = '';
      ticket = '';
    }
  });

  // Sync reload setting from IndexedDB each time the dialog opens
  $effect(() => {
    if (!open) return;
    getExtensionSettings().then(s => { reloadPortals = s.reloadPortalsOnActivation; }).catch(() => {});
  });

  // Focus first text field when dialog opens (if any)
  $effect(() => {
    if (!open || !target) return;
    const policy = target.data.policyRules;
    // Wait a tick for the DOM to render
    setTimeout(() => {
      if (policy.justificationRequired) {
        document.getElementById('activate-justification')?.focus();
      } else if (policy.ticketingRequired) {
        document.getElementById('activate-ticket')?.focus();
      }
    }, 50);
  });

  const displayName = $derived(
    !target ? '' :
    target.kind === 'role' ? target.data.roleName : target.data.groupName
  );

  const policy = $derived(target?.data.policyRules);

  const canSubmit = $derived(
    !submitting &&
    durationMinutes > 0 &&
    (!policy?.justificationRequired || justification.trim().length > 0) &&
    (!policy?.ticketingRequired || ticket.trim().length > 0)
  );

  async function handleSubmit() {
    if (!target || !canSubmit) return;
    submitting = true;
    await onConfirm({
      id: target.data.id,
      kind: target.kind,
      duration: minutesToIso(durationMinutes),
      justification: justification || undefined,
      ticket: ticket || undefined,
    });
    submitting = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 bg-overlay z-40 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
      aria-hidden="true"
    />
    <Dialog.Content
      aria-labelledby="activate-dialog-title"
      class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-90 bg-surface-800 rounded-xl border border-surface-600 flex flex-col shadow-2xl z-50 focus:outline-none data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-surface-600">
        <div class="flex flex-col gap-0.5 min-w-0">
          <span id="activate-dialog-title" class="text-sm font-semibold text-text-primary truncate">Request Activation</span>
          <span class="text-xs text-text-muted truncate">{displayName}</span>
        </div>
        <Button variant="icon" onclick={() => (open = false)} aria-label="Close activation dialog">
          <X class="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>

      <!-- Body -->
      <div class="flex flex-col gap-4 px-5 py-4">
        {#if policy?.approvalRequired}
          <div class="flex items-center gap-2">
            <Badge color="amber">Requires approval</Badge>
            <span class="text-xs text-text-muted">Your request will be reviewed</span>
          </div>
        {/if}
        {#if policy?.authContextRequired}
          <div class="flex items-center gap-2">
            <Badge color="amber">Step-up auth required</Badge>
            <span class="text-xs text-text-muted">A prompt may appear</span>
          </div>
        {/if}

        <!-- Duration slider -->
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <label for="activate-duration" class="text-xs text-text-tertiary font-medium uppercase tracking-wide">Duration</label>
            <span class="text-sm font-semibold text-brand-secondary tabular-nums">{formatMinutes(durationMinutes)}</span>
          </div>
          <input
            id="activate-duration"
            type="range"
            min="30"
            max={maxMinutes}
            step="30"
            bind:value={durationMinutes}
            class="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-brand-secondary bg-surface-600"
            aria-label="Duration: {formatMinutes(durationMinutes)}"
            aria-valuemin={30}
            aria-valuemax={maxMinutes}
            aria-valuenow={durationMinutes}
          />
          <div class="flex justify-between text-[10px] text-text-disabled">
            <span>30 min</span>
            <span>{formatMinutes(maxMinutes)}</span>
          </div>
        </div>

        {#if policy?.justificationRequired}
          <Textarea
            label="Justification"
            id="activate-justification"
            bind:value={justification}
            rows={3}
            placeholder="Explain why you need this access..."
          />
        {/if}

        {#if policy?.ticketingRequired}
          <Input
            label="Ticket Number"
            id="activate-ticket"
            bind:value={ticket}
            placeholder="e.g. INC-12345"
          />
        {/if}
      </div>

      <!-- Portal reload option -->
      <div class="px-5 pb-4 flex flex-col gap-1.5">
        <div class="flex items-center justify-between gap-3">
          <label for="activate-reload-portals" class="text-sm text-text-secondary cursor-pointer">Reload Microsoft tabs after activation</label>
          <Toggle
            id="activate-reload-portals"
            checked={reloadPortals}
            onchange={(val) => {
              reloadPortals = val;
              sendCommand(MessageType.UPDATE_EXTENSION_SETTING, { patch: { reloadPortalsOnActivation: val } }).catch(() => {});
            }}
          />
        </div>
        <p class="text-xs text-text-muted">Clears cookies and reloads Azure / Entra portal tabs so new permissions take effect.</p>
      </div>

      <!-- Footer -->
      <div class="flex gap-2 px-5 py-4 border-t border-surface-600">
        <Button
          variant="brand"
          class="flex-1 flex items-center justify-center gap-1.5 whitespace-nowrap {!canSubmit ? 'opacity-50' : ''}"
          disabled={submitting}
          aria-disabled={!canSubmit}
          onclick={handleSubmit}
          aria-label="Request activation of {displayName}"
        >
          {#if submitting}
            <Spinner />
            Requesting...
          {:else}
            Request Activation
          {/if}
        </Button>
        <Button variant="ghost" class="flex-1 whitespace-nowrap" onclick={() => (open = false)} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
