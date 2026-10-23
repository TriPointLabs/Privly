<script lang="ts">
  /**
   * Pinned prompt offering the optional AU_SCOPE permission so AU-scoped roles show admin unit names.
   * Shown only when the account has AU-scoped Entra entries, lacks the scope, and has not dismissed it.
   */
  import { Button, Card, Spinner } from './ui/index.js';
  import { sendCommand, MessageType } from '../../types/messages.js';
  import { AU_SCOPE } from '../../tools/oauth.js';
  import { consentUrlFor } from '../../constants';
  import type { AccountRecord } from '../../tools/db.js';
  import type { EligibleRole, ActiveAssignment } from '../../types/pim';

  let { account, eligibleRoles, activeAssignments }: {
    account: AccountRecord;
    eligibleRoles: EligibleRole[];
    activeAssignments: ActiveAssignment[];
  } = $props();

  let pending = $state(false);

  const visible = $derived(
    !account.auScopePromptDismissed
    && !account.grantedScopes?.includes(AU_SCOPE)
    && [...eligibleRoles, ...activeAssignments].some(e =>
      'directoryScopeId' in e && /\/administrativeUnits\//i.test(e.directoryScopeId ?? '')),
  );

  const consentUrl = $derived(consentUrlFor(account.cloud));

  // The consent window can close the popup, so the ack is unreliable; failures arrive via account.auScopeGrantError.
  async function enable() {
    pending = true;
    try {
      await sendCommand(MessageType.GRANT_AU_SCOPE, { accountId: account.id });
    } catch {
      // Outcome is persisted on the account record.
    } finally {
      pending = false;
    }
  }

  function dismiss() {
    sendCommand(MessageType.UPDATE_ACCOUNT_SETTING, { accountId: account.id, patch: { auScopePromptDismissed: true } }).catch(() => {});
  }
</script>

{#if visible}
  <div role="region" aria-label="Admin unit permission">
    <Card class="flex flex-col gap-2">
      <p class="text-xs text-text-secondary">
        Privly can show admin unit names with one extra permission (Read administrative units). An administrator may need to approve it.
      </p>
      {#if account.auScopeGrantError}
        <p role="alert" class="text-xs text-status-red">{account.auScopeGrantError}</p>
        {#if consentUrl}
          <a href={consentUrl} target="_blank" rel="noopener noreferrer" class="text-xs text-brand-secondary underline break-all">
            {consentUrl}
          </a>
        {/if}
      {/if}
      <div class="flex items-center justify-end gap-2">
        <Button variant="ghost" onclick={dismiss} disabled={pending}>Not now</Button>
        <Button variant="brand" onclick={enable} disabled={pending} class="flex items-center gap-1.5">
          {#if pending}<Spinner />{/if}
          Enable
        </Button>
      </div>
    </Card>
  </div>
{/if}
