<script lang="ts">
  /**
   * Activation request dialog for eligible roles and groups. The target's
   * cached policy drives everything: the duration slider is capped at the
   * policy maximum, justification/ticket fields only block submission when
   * the policy requires them, and initial focus lands on the first required
   * field. Approval-required outcomes are handled by the caller via the ack.
   */
  import { Dialog, Popover } from "bits-ui";
  import { Button, Badge, Input, Textarea, Spinner, Toggle } from './ui/index.js';
  import { X, ChevronDown, Trash2 } from '@lucide/svelte';
  import type { EligibleRole, EligibleGroup } from '../../types/pim.js';
  import type { JustificationPrefillRecord } from '../../tools/db.js';
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
    /** True when the user asked for this justification to be remembered (CS-3). */
    savePrefill?: boolean;
  };

  let { open = $bindable(false), target, onConfirm, prefills = [], onDeletePrefill }: {
    open: boolean;
    target: { kind: 'role'; data: EligibleRole } | { kind: 'group'; data: EligibleGroup } | null;
    onConfirm: (params: ActivationParams) => Promise<void>;
    /** Saved justifications for the active account, most recently used first. */
    prefills?: JustificationPrefillRecord[];
    onDeletePrefill?: (prefillId: string) => Promise<void>;
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
  let savePrefill = $state(false);
  let prefillPickerOpen = $state(false);

  // Reset form when target changes
  $effect(() => {
    if (target) {
      durationMinutes = Math.min(toMinutes(target.data.policyRules.maximumDuration), 1440);
      justification = '';
      ticket = '';
      savePrefill = false;
      prefillPickerOpen = false;
    }
  });

  /**
   * Fills the justification field from a saved prefill. Chosen text is not
   * re-saved on submit -- it is already stored, and ticking the box again would
   * only rewrite the same row.
   */
  function applyPrefill(text: string) {
    justification = text;
    savePrefill = false;
    prefillPickerOpen = false;
    document.getElementById('activate-justification')?.focus();
  }

  async function removePrefill(prefillId: string) {
    await onDeletePrefill?.(prefillId);
    if (prefills.length <= 1) prefillPickerOpen = false;
  }

  /** True when the current text is one of the saved prefills, picked or retyped. */
  const matchesSavedPrefill = $derived(
    justification.trim().length > 0 && prefills.some(p => p.text === justification.trim())
  );

  // Offering to save text that is already saved would be a no-op, so the
  // toggle only appears for justification the user actually typed.
  const isNewJustification = $derived(justification.trim().length > 0 && !matchesSavedPrefill);

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
      // Reusing a saved justification re-sends the save so the service worker
      // refreshes its lastUsedAt, keeping the picker in most-recently-used order.
      savePrefill: (savePrefill && isNewJustification) || matchesSavedPrefill,
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
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-2">
              <label for="activate-justification" class="field-label">Justification</label>
              {#if prefills.length > 0}
                <Popover.Root bind:open={prefillPickerOpen}>
                  <Popover.Trigger
                    class="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-secondary"
                    aria-label="Choose a saved justification"
                  >
                    Saved
                    <ChevronDown class="w-3 h-3" aria-hidden="true" />
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content
                      align="end"
                      sideOffset={4}
                      class="z-[60] w-64 max-h-56 overflow-y-auto rounded-lg border border-surface-600 bg-surface-800 p-1 shadow-2xl focus:outline-none"
                    >
                      <ul class="flex flex-col">
                        {#each prefills as prefill (prefill.id)}
                          <li class="flex items-center gap-1 group">
                            <button
                              type="button"
                              class="flex-1 min-w-0 text-left text-xs text-text-secondary hover:text-text-primary hover:bg-surface-700 rounded px-2 py-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-secondary"
                              onclick={() => applyPrefill(prefill.text)}
                            >
                              <span class="block truncate">{prefill.text}</span>
                            </button>
                            <Button
                              variant="icon-danger"
                              aria-label="Delete saved justification"
                              onclick={() => removePrefill(prefill.id)}
                            >
                              <Trash2 class="w-3.5 h-3.5" aria-hidden="true" />
                            </Button>
                          </li>
                        {/each}
                      </ul>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              {/if}
            </div>
            <Textarea
              id="activate-justification"
              bind:value={justification}
              rows={3}
              placeholder="Explain why you need this access..."
            />
            {#if isNewJustification}
              <div class="flex items-center justify-between gap-3 pt-0.5">
                <label for="activate-save-prefill" class="text-xs text-text-muted cursor-pointer">Save for next time</label>
                <Toggle
                  id="activate-save-prefill"
                  checked={savePrefill}
                  onchange={(val) => (savePrefill = val)}
                  aria-label="Save this justification for next time"
                />
              </div>
            {/if}
          </div>
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
