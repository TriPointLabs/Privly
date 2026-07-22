<script lang="ts">
  /**
   * Renders one of two pending-item lists depending on `type`:
   * - 'approval': requests where the user is the approver. Each card moves
   *   through a three-state machine (normal -> expanded detail -> approving
   *   with a justification form); Deny acts immediately, Approve requires the
   *   justification step.
   * - 'request': the user's own submitted requests, cancel-only.
   * `actingId` disables just the card whose command is in flight so other
   * items stay interactive while one awaits the service worker.
   */
  import { slide } from 'svelte/transition';
  import { Button, Badge, Card, Textarea, Spinner } from './ui/index.js';
  import { ChevronDown, X } from '@lucide/svelte';
  import { formatDuration } from '../utils/duration.js';
  import { formatScopeLabel } from '../../tools/scopeParser.js';
  import type { ApprovalItem, PendingRequest } from '../../types/pim.js';

  let { items, type, onApprovalConfirm, onApprovalDeny, onRequestCancel }: {
    items: ApprovalItem[] | PendingRequest[];
    type: 'approval' | 'request';
    onApprovalConfirm?: (id: string, justification: string) => Promise<void>;
    onApprovalDeny?: (id: string) => Promise<void>;
    onRequestCancel?: (id: string) => Promise<void>;
  } = $props();

  let expandedId = $state<string | null>(null);
  let approvingId = $state<string | null>(null);
  let approverJustification = $state('');
  let actingId = $state<string | null>(null);

  function cardState(id: string): 'normal' | 'expanded' | 'approving' {
    if (approvingId === id) return 'approving';
    if (expandedId === id) return 'expanded';
    return 'normal';
  }

  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }

  function startApproving(id: string) {
    approvingId = id;
    expandedId = null;
    approverJustification = '';
  }

  $effect(() => {
    if (!approvingId) return;
    const id = approvingId;
    document.getElementById(`approver-justification-${id}`)?.focus();
  });

  function cancelApproving() {
    approvingId = null;
  }

  async function handleConfirm(approval: ApprovalItem) {
    actingId = approval.id;
    await onApprovalConfirm?.(approval.id, approverJustification);
    actingId = null;
    approvingId = null;
  }

  async function handleDeny(approval: ApprovalItem) {
    actingId = approval.id;
    await onApprovalDeny?.(approval.id);
    actingId = null;
  }

  async function handleCancel(req: PendingRequest) {
    actingId = req.id;
    await onRequestCancel?.(req.id);
    actingId = null;
  }
</script>

<div class="flex flex-col gap-1.5">
  {#if type === 'approval'}
    {#each items as item (item.id)}
      {@const approval = item as ApprovalItem}
      {@const state = cardState(approval.id)}

      {#if state === 'approving'}
        <Card class="flex flex-col gap-3">
          <div class="flex flex-col gap-0.5">
            <span class="text-[10px] font-semibold text-text-faint uppercase tracking-wider">Approving</span>
            <span class="text-sm text-text-primary">{approval.roleName}</span>
            <span class="text-xs text-text-muted">{approval.requestorName} requested {formatDuration(approval.durationRequested)}</span>
          </div>
          <Textarea
            label="Your Justification"
            id="approver-justification-{approval.id}"
            bind:value={approverJustification}
            rows={3}
            placeholder="Explain why you are approving this request..."
            onkeydown={(e) => {
              // Plain Enter submits; Ctrl+Enter falls through to insert a newline.
              if (e.key === 'Enter' && !e.ctrlKey) {
                e.preventDefault();
                if (approverJustification.trim() && actingId !== approval.id) handleConfirm(approval);
              }
            }}
          />
          <div class="flex gap-2">
            <Button
              variant="approve"
              class="flex-1"
              disabled={approverJustification.trim() === '' || actingId === approval.id}
              aria-disabled={approverJustification.trim() === '' || actingId === approval.id}
              aria-label="Confirm approval of {approval.roleName} for {approval.requestorName}"
              onclick={() => handleConfirm(approval)}
            >
              {#if actingId === approval.id}
                <Spinner />
              {:else}
                Confirm
              {/if}
            </Button>
            <Button
              variant="ghost"
              class="flex-1"
              disabled={actingId === approval.id}
              onclick={cancelApproving}
            >
              Cancel
            </Button>
          </div>
        </Card>
      {:else}
        <Card class="flex flex-col gap-0">
          <!-- Header row -->
          <div class="flex items-center gap-2">
            <div class="flex flex-col gap-0.5 flex-1 min-w-0">
              <span class="text-sm text-text-primary">{approval.roleName}</span>
              <span class="text-xs text-text-muted">Requested by {approval.requestorName}</span>
            </div>
            <button
              type="button"
              onclick={() => toggleExpand(approval.id)}
              aria-expanded={state === 'expanded'}
              aria-controls="approval-detail-{approval.id}"
              aria-label="Show details for {approval.roleName} request from {approval.requestorName}"
              class="shrink-0 p-1 rounded hover:bg-surface-600 transition-colors text-text-faint hover:text-text-tertiary"
            >
              <ChevronDown
                class="w-4 h-4 transition-transform duration-200 {state === 'expanded' ? 'rotate-180' : ''}"
                aria-hidden="true"
              />
            </button>
          </div>

          <!-- Expandable detail panel -->
          {#if state === 'expanded'}
            <div
              id="approval-detail-{approval.id}"
              class="mt-2 -mx-3 border-t border-surface-600"
              transition:slide={{ duration: 200 }}
            >
              <div class="flex flex-col">
                <div class="flex justify-between items-center px-3 py-2 bg-surface-900">
                  <span class="text-xs text-text-muted">Duration</span>
                  <span class="text-xs text-text-primary font-medium">{formatDuration(approval.durationRequested)}</span>
                </div>
                <div class="flex flex-col gap-1 px-3 py-2 bg-surface-900 border-t border-surface-700">
                  <span class="text-xs text-text-muted">Justification</span>
                  <span class="text-xs text-text-secondary leading-relaxed">{approval.requestorJustification}</span>
                </div>
              </div>
            </div>
          {/if}

          <!-- Action buttons — always visible -->
          <div class="flex gap-2 mt-2 pt-2 border-t border-surface-600 -mx-3 px-3">
            <Button
              variant="approve"
              class="flex-1"
              disabled={actingId === approval.id}
              onclick={() => startApproving(approval.id)}
              aria-label="Approve {approval.roleName} request from {approval.requestorName}"
            >
              {#if actingId === approval.id}
                <Spinner />
              {:else}
                Approve
              {/if}
            </Button>
            <Button
              variant="deny"
              class="flex-1"
              disabled={actingId === approval.id}
              onclick={() => handleDeny(approval)}
              aria-label="Deny {approval.roleName} request from {approval.requestorName}"
            >
              {#if actingId === approval.id}
                <Spinner />
              {:else}
                Deny
              {/if}
            </Button>
          </div>
        </Card>
      {/if}
    {/each}
  {:else}
    {#each items as item (item.id)}
      {@const req = item as PendingRequest}
      <Card class="flex items-center justify-between">
        <div class="flex flex-col gap-0.5 min-w-0">
          <span class="text-sm text-text-primary truncate">{req.roleName}</span>
          {#if req.scope}
            <span class="text-xs text-text-faint truncate">{formatScopeLabel(req.scope)}</span>
          {/if}
        </div>
        <div class="flex items-center gap-2 shrink-0 ml-2">
          <Badge color="amber">Pending</Badge>
          <Button
            variant="icon-danger"
            disabled={actingId === req.id}
            onclick={() => handleCancel(req)}
            aria-label="Cancel request for {req.roleName}"
          >
            {#if actingId === req.id}
              <Spinner />
            {:else}
              <X class="w-3.5 h-3.5" aria-hidden="true" />
            {/if}
          </Button>
        </div>
      </Card>
    {/each}
  {/if}
</div>
