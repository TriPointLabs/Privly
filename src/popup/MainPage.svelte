<script lang="ts">
  /**
   * Main dashboard page, shown once at least one account is signed in.
   *
   * Owns the four PIM sections (eligible activations, active assignments,
   * pending approvals, my pending requests) and coordinates the detail panel,
   * activation dialog, sign-out confirmation, and account switcher.
   */
  import { slide } from 'svelte/transition';
  import EligibleRoleCard from './components/EligibleRoleCard.svelte';
  import EligibleGroupCard from './components/EligibleGroupCard.svelte';
  import ActiveAssignmentCard from './components/ActiveAssignmentCard.svelte';
  import PendingSection from './components/PendingSection.svelte';
  import AccountSwitcher from './components/AccountSwitcher.svelte';
  import DetailPage from './components/DetailPage.svelte';
  import ActivateDialog from './components/ActivateDialog.svelte';
  import AzureDetailPage from './components/AzureDetailPage.svelte';
  import AccountAttentionPage from './components/AccountAttentionPage.svelte';
  import SignOutConfirmDialog from './components/SignOutConfirmDialog.svelte';
  import type { ActivationParams } from './components/ActivateDialog.svelte';
  import { Avatar, Button, Badge, Card, Spinner } from './components/ui/index.js';
  import { RefreshCw, Settings, ChevronDown, ChevronRight, Search } from '@lucide/svelte';
  import type { EligibleRole, EligibleGroup, ActiveAssignment, ActiveRoleAssignment, ActiveGroupAssignment, DetailTarget, ApprovalItem, PendingRequest } from '../types/pim';
  import browser from 'webextension-polyfill';
  import { sendCommand, MessageType, type StoreName, type CommandAck } from '../types/messages.js';
  import { Eye, EyeOff } from '@lucide/svelte';
  import { type AccountRecord, type ActivatingRecord, type JustificationPrefillRecord } from '../tools/db.js';
  import { loadAccounts, loadEligibleRoles, loadActiveAssignments, loadEligibleGroups, loadApprovals, loadPendingRequests, loadActivating, loadAzureSubscriptionGroups, loadJustificationPrefills, loadSyncRunning, type AzureSubscriptionGroup } from './data.js';
  import { toMinutes } from './utils/duration.js';
  import privlyTextColor from '../assets/privly-text-color.svg';

  let { onAddAccount, onOpenSettings, addAlert }: {
    onAddAccount: () => void;
    onOpenSettings: () => void;
    addAlert: (type: 'success' | 'error' | 'info', message: string) => void;
  } = $props();

  let syncing = $state(false);

  /**
   * Reads the persisted sync marker. The `SYNC_STATUS` broadcast only reaches a
   * popup that is already mounted, and after the first sign-in this component
   * mounts partway through the initial sync -- the popup having been closed by
   * the interactive sign-in window -- so the broadcast that started it is long
   * gone by then.
   */
  async function refreshSyncState() {
    syncing = await loadSyncRunning();
  }

  // A sync cycle fires 10+ DB_CHANGED notifications in bursts. Collect store
  // names for a short window and run each affected refresher once per burst
  // instead of once per message.
  const REFRESH_DEBOUNCE_MS = 100;
  let pendingStores = new Set<StoreName>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRefresh(changed: StoreName[]) {
    for (const s of changed) pendingStores.add(s);
    flushTimer ??= setTimeout(() => {
      const stores = pendingStores;
      pendingStores = new Set();
      flushTimer = null;
      // Checked before the accounts early-return below: sign-in reports
      // 'accounts' and 'states' in the same burst, and the early return would
      // otherwise drop the syncing indicator on exactly the flow that needs it.
      if (stores.has('states')) refreshSyncState();
      if (stores.has('accounts')) {
        // refreshAccounts re-runs every per-account query itself.
        refreshAccounts();
        return;
      }
      if (stores.has('roles') || stores.has('role_definitions') || stores.has('role_policies') || stores.has('activations')) refreshRoles();
      if (stores.has('activations') || stores.has('azure_roles') || stores.has('azure_scopes') || stores.has('azure_activations')) refreshActivations();
      if (stores.has('groups') || stores.has('group_policies') || stores.has('activations')) refreshGroups();
      if (stores.has('approvals')) refreshApprovals();
      if (stores.has('pending_requests')) refreshPendingRequests();
      if (stores.has('activating')) refreshActivating();
      if (stores.has('azure_roles') || stores.has('azure_scopes') || stores.has('azure_activations')) refreshAzureRoles();
      if (stores.has('justification_prefills')) refreshPrefills();
    }, REFRESH_DEBOUNCE_MS);
  }

  // CRITICAL: message listener registered synchronously before any await (CLAUDE.md requirement)
  browser.runtime.onMessage.addListener((message: { type: string; stores?: StoreName[]; running?: boolean }) => {
    if (message.type === 'DB_CHANGED') {
      scheduleRefresh(message.stores ?? []);
    }
    if (message.type === 'SYNC_STATUS') {
      syncing = message.running ?? false;
    }
  });

  let accountSwitcherOpen = $state(false);
  let detailTarget = $state<DetailTarget | null>(null);
  let azureDrillTarget = $state<AzureSubscriptionGroup | null>(null);

  let eligibleOpen = $state(true);
  let eligibleEntraOpen = $state(true);
  let eligibleAzureOpen = $state(true);
  let eligibleGroupsOpen = $state(true);
  let activeOpen = $state(true);
  let entraSearch = $state('');
  let azureSearch = $state('');
  let groupSearch = $state('');
  let activeSearch = $state('');
  let approvalsOpen = $state(true);
  let requestsOpen = $state(true);

  let accounts = $state<AccountRecord[]>([]);
  let activeAccountId = $state<string | null>(null);

  /**
   * Reads the accounts list and the active account ID from storage, then
   * re-runs every per-account query. Called on mount and on every
   * `DB_CHANGED` notification that includes `accounts`.
   */
  async function refreshAccounts() {
    const loaded = await loadAccounts();
    accounts = loaded.accounts;
    activeAccountId = loaded.activeAccountId;
    await refreshAll();
  }

  /** Re-runs every per-account query for the active account. */
  function refreshAll(): Promise<unknown> {
    return Promise.all([refreshRoles(), refreshActivations(), refreshGroups(), refreshApprovals(), refreshPendingRequests(), refreshActivating(), refreshAzureRoles(), refreshPrefills()]);
  }

  async function refreshRoles() {
    const account = accounts.find(a => a.id === activeAccountId);
    eligibleRoles = account ? await loadEligibleRoles(account) : [];
  }

  async function refreshActivations() {
    const account = accounts.find(a => a.id === activeAccountId);
    activeAssignments = account ? await loadActiveAssignments(account) : [];
  }

  async function refreshGroups() {
    const account = accounts.find(a => a.id === activeAccountId);
    eligibleGroups = account ? await loadEligibleGroups(account) : [];
  }

  async function refreshApprovals() {
    pendingApprovals = activeAccountId ? await loadApprovals(activeAccountId) : [];
  }

  async function refreshPendingRequests() {
    myPendingRequests = activeAccountId ? await loadPendingRequests(activeAccountId) : [];
  }

  async function refreshActivating() {
    activatingRecords = activeAccountId ? await loadActivating(activeAccountId) : [];
  }

  let justificationPrefills = $state<JustificationPrefillRecord[]>([]);

  async function refreshPrefills() {
    justificationPrefills = activeAccountId ? await loadJustificationPrefills(activeAccountId) : [];
  }

  /**
   * Removes a saved justification via the service worker. The SW fires
   * `DB_CHANGED` for `justification_prefills`, which re-runs `refreshPrefills`,
   * so the picker updates without any local mutation here.
   */
  async function handleDeletePrefill(prefillId: string): Promise<void> {
    if (!activeAccountId) return;
    const ack = await sendCommand(MessageType.DELETE_JUSTIFICATION_PREFILL, { accountId: activeAccountId, prefillId });
    if (!ack.ok) addAlert('error', ack.error ?? 'Could not delete the saved justification');
  }

  /**
   * Toggles the per-account `showPermanentAssignments` setting and persists it
   * via the service worker. The SW writes to `AccountRecord` and fires
   * `DB_CHANGED` for `accounts`, which triggers a re-read.
   */
  async function toggleShowPermanent() {
    if (!activeAccountId) return;
    const current = activeAccount?.showPermanentAssignments ?? false;
    await sendCommand(MessageType.UPDATE_ACCOUNT_SETTING, {
      accountId: activeAccountId,
      patch: { showPermanentAssignments: !current },
    });
  }

  let azureSubscriptionGroups = $state<AzureSubscriptionGroup[]>([]);

  async function refreshAzureRoles() {
    azureSubscriptionGroups = activeAccountId ? await loadAzureSubscriptionGroups(activeAccountId) : [];
  }

  refreshAccounts();
  refreshSyncState();

  let eligibleRoles = $state<EligibleRole[]>([]);
  const eligibleEntraRoles = $derived(eligibleRoles.filter(r => r.roleType === 'EntraRole'));

  let eligibleGroups = $state<EligibleGroup[]>([]);

  let activeAssignments = $state<ActiveAssignment[]>([]);
  const visibleAssignments = $derived(
    (activeAccount?.showPermanentAssignments ?? false)
      ? activeAssignments
      : activeAssignments.filter(a => !('isPermanent' in a && a.isPermanent))
  );

  const filteredEntraRoles = $derived(
    entraSearch.trim() === ''
      ? eligibleEntraRoles
      : eligibleEntraRoles.filter(r => r.roleName.toLowerCase().includes(entraSearch.trim().toLowerCase()))
  );
  const filteredGroups = $derived(
    groupSearch.trim() === ''
      ? eligibleGroups
      : eligibleGroups.filter(g => g.groupName.toLowerCase().includes(groupSearch.trim().toLowerCase()))
  );
  const filteredAzureGroups = $derived(
    azureSearch.trim() === ''
      ? azureSubscriptionGroups
      : azureSubscriptionGroups.filter(g => g.displayName.toLowerCase().includes(azureSearch.trim().toLowerCase()))
  );
  const filteredActiveAssignments = $derived(
    activeSearch.trim() === ''
      ? visibleAssignments
      : visibleAssignments.filter(a => {
          const name = 'roleName' in a ? a.roleName : `${a.groupName} (${a.accessId})`;
          return name.toLowerCase().includes(activeSearch.trim().toLowerCase());
        })
  );

  let pendingApprovals = $state<ApprovalItem[]>([]);

  let myPendingRequests = $state<PendingRequest[]>([]);

  let activatingRecords = $state<ActivatingRecord[]>([]);
  const activatingRoleIds = $derived(new Set(
    activatingRecords.filter(r => r.kind === 'role').map(r => r.recordId)
  ));
  const activatingGroupIds = $derived(new Set(
    activatingRecords.filter(r => r.kind === 'group').map(r => r.recordId)
  ));
  const activatingAzureRoleIds = $derived(new Set(
    activatingRecords.filter(r => r.kind === 'azure_role').map(r => r.recordId)
  ));

  const activeAccount = $derived(accounts.find(a => a.id === activeAccountId) ?? null);
  const accountNeedsAttention = $derived(activeAccount?.needsAttention ?? null);

  async function handleSignInAgain() {
    if (!activeAccount) return;
    await sendCommand(MessageType.SIGN_IN_INTERACTIVE, { accountId: activeAccount.id });
  }

  let signOutConfirmOpen = $state(false);
  let signOutTarget = $state<typeof activeAccount>(null);

  /**
   * Closes the account switcher and opens the sign-out confirmation dialog
   * for the currently active account.
   */
  function openSignOutConfirm() {
    if (!activeAccount) return;
    signOutTarget = activeAccount;
    accountSwitcherOpen = false;
    signOutConfirmOpen = true;
  }

  async function handleSignOutConfirmed(accountId: string) {
    await sendCommand(MessageType.SIGN_OUT, { accountId });
  }

  let activationTarget = $state<{ kind: 'role'; data: EligibleRole } | { kind: 'group'; data: EligibleGroup } | null>(null);
  let activationDialogOpen = $state(false);

  /**
   * Sends TRIGGER_SYNC to the service worker to run a full token refresh and
   * Graph data sync immediately. The SYNC_STATUS messages from the SW drive the
   * spinner indicator; no addAlert here since the data updates are visible in place.
   */
  async function handleRefresh() {
    await sendCommand(MessageType.TRIGGER_SYNC, {});
  }


  /**
   * Handles the activation dialog submission. Dispatches ACTIVATE_ROLE or
   * ACTIVATE_GROUP to the service worker and waits for the CommandAck. The
   * dialog stays open (showing its own spinner) while the request is in-flight.
   * On success or failure, closes the dialog and shows the appropriate alert.
   * The service worker also fires an OS notification independently, so the user
   * gets feedback even if they closed the popup while waiting.
   * @param params - Activation parameters from the dialog.
   */
  async function handleActivation(params: ActivationParams): Promise<void> {
    if (!activeAccountId) return;

    // Resolve display name and policy from the activation target (set when the dialog opened).
    // This works for both Entra roles (from eligibleRoles) and Azure roles (from AzureDetailPage).
    const displayName = activationTarget?.kind === 'role'
      ? activationTarget.data.roleName
      : activationTarget?.data.groupName;
    const approvalRequired = activationTarget?.data.policyRules.approvalRequired ?? false;

    const isAzure = activationTarget?.kind === 'role' && activationTarget.data.roleType === 'AzureRole';

    let ack: CommandAck;
    if (isAzure) {
      ack = await sendCommand(MessageType.ACTIVATE_AZURE_ROLE, {
        accountId: activeAccountId,
        azureRoleId: params.id,
        durationMinutes: toMinutes(params.duration),
        justification: params.justification,
        ticketNumber: params.ticket,
        ticketSystem: params.ticketSystem,
        savePrefill: params.savePrefill,
      });
    } else if (params.kind === 'role') {
      ack = await sendCommand(MessageType.ACTIVATE_ROLE, {
        accountId: activeAccountId,
        roleId: params.id,
        durationMinutes: toMinutes(params.duration),
        justification: params.justification,
        ticketNumber: params.ticket,
        ticketSystem: params.ticketSystem,
        savePrefill: params.savePrefill,
      });
    } else {
      ack = await sendCommand(MessageType.ACTIVATE_GROUP, {
        accountId: activeAccountId,
        groupId: params.id,
        durationMinutes: toMinutes(params.duration),
        justification: params.justification,
        ticketNumber: params.ticket,
        ticketSystem: params.ticketSystem,
        savePrefill: params.savePrefill,
      });
    }

    activationDialogOpen = false;

    if (!ack.ok) {
      addAlert('error', ack.error ?? 'Activation failed');
      return;
    }

    if (approvalRequired) {
      addAlert('info', `Activation request submitted for "${displayName}" -- awaiting approval`);
    } else {
      addAlert('success', `"${displayName}" activated successfully`);
      activeOpen = true;
    }
    // No local state mutation -- DB_CHANGED from the service worker triggers refreshActivations() + refreshRoles() + refreshGroups()
  }

  /**
   * Dispatches DEACTIVATE_ROLE or DEACTIVATE_GROUP to the service worker and
   * shows the result as an alert. The service worker fires an OS notification
   * independently for out-of-popup feedback.
   * @param id - The `ActivationRecord.id` of the assignment to deactivate.
   */
  async function handleDeactivate(id: string): Promise<void> {
    if (!activeAccountId) return;

    const assignment = activeAssignments.find(a => a.id === id);
    const displayName = assignment && 'roleName' in assignment
      ? assignment.roleName
      : assignment && 'groupName' in assignment
        ? assignment.groupName
        : id;

    const isAzure = assignment && 'roleType' in assignment && assignment.roleType === 'AzureRole';
    const isRole = assignment ? 'roleName' in assignment : true;

    let ack: CommandAck;
    if (isAzure) {
      ack = await sendCommand(MessageType.DEACTIVATE_AZURE_ROLE, { accountId: activeAccountId, azureActivationId: id });
    } else if (isRole) {
      ack = await sendCommand(MessageType.DEACTIVATE_ROLE, { accountId: activeAccountId, activationId: id });
    } else {
      ack = await sendCommand(MessageType.DEACTIVATE_GROUP, { accountId: activeAccountId, activationId: id });
    }

    if (!ack.ok) {
      addAlert('error', ack.error ?? 'Deactivation failed');
      return;
    }

    addAlert('success', `"${displayName}" deactivated`);
    // No local state mutation -- DB_CHANGED from the service worker triggers refreshActivations()
  }

  async function handleApprovalConfirm(id: string, justification: string): Promise<void> {
    if (!activeAccountId) return;
    const name = pendingApprovals.find(a => a.id === id)?.roleName;
    const ack = await sendCommand(MessageType.APPROVE_REQUEST, { accountId: activeAccountId, approvalId: id, justification });
    if (!ack.ok) {
      addAlert('error', ack.error ?? 'Approval failed');
      return;
    }
    addAlert('success', `Approved "${name}"`);
    // No local mutation -- DB_CHANGED from the service worker triggers refreshApprovals()
  }

  async function handleApprovalDeny(id: string): Promise<void> {
    if (!activeAccountId) return;
    const name = pendingApprovals.find(a => a.id === id)?.roleName;
    const ack = await sendCommand(MessageType.DENY_REQUEST, { accountId: activeAccountId, approvalId: id });
    if (!ack.ok) {
      addAlert('error', ack.error ?? 'Denial failed');
      return;
    }
    addAlert('info', `Denied "${name}"`);
    // No local mutation -- DB_CHANGED from the service worker triggers refreshApprovals()
  }

  async function handleRequestCancel(id: string): Promise<void> {
    if (!activeAccountId) return;
    const request = myPendingRequests.find(r => r.id === id);
    const name = request?.roleName;
    const kind = request?.kind ?? 'role';
    const ack = await sendCommand(MessageType.CANCEL_REQUEST, { accountId: activeAccountId, requestId: id, kind });
    if (!ack.ok) {
      addAlert('error', ack.error ?? 'Cancel failed');
      return;
    }
    addAlert('info', `Cancelled request for "${name}"`);
    // No local mutation -- DB_CHANGED from the service worker triggers refreshPendingRequests()
  }

  /**
   * Switches the active account, persists the selection to `storage.local`,
   * and closes the account switcher panel.
   * @param id - The `AccountRecord.id` UUID of the account to make active.
   */
  async function handleAccountSelect(id: string) {
    activeAccountId = id;
    accountSwitcherOpen = false;
    await browser.storage.local.set({ activeAccountId: id });
    await refreshAll();
  }

  function handleAddAccount() {
    accountSwitcherOpen = false;
    onAddAccount();
  }

  function openDetail(target: DetailTarget) {
    detailTarget = target;
  }
</script>

{#if detailTarget}
  <DetailPage target={detailTarget} onBack={() => (detailTarget = null)} />
{:else if azureDrillTarget && activeAccountId}
  <AzureDetailPage
    scopeId={azureDrillTarget?.scopeId ?? ''}
    accountId={activeAccountId}
    displayName={azureDrillTarget?.displayName ?? ''}
    isManagementGroup={azureDrillTarget?.isManagementGroup ?? false}
    {activatingAzureRoleIds}
    onBack={() => (azureDrillTarget = null)}
    onActivate={(role) => { activationTarget = { kind: 'role', data: role }; activationDialogOpen = true; }}
  />
{:else}
  <div class="relative flex flex-col h-full bg-surface-900 text-text-primary">

    <!-- Header -->
    <header class="flex items-center justify-between px-4 h-12 bg-surface-800 border-b border-surface-700 shrink-0">
      <img src={privlyTextColor} aria-hidden="true" alt="" class="h-[1em]" />
      <div class="flex items-center gap-1">
        <!-- Sync status indicator -->
        {#if syncing}
          <span class="flex items-center px-1" aria-live="polite" aria-label="Syncing data">
            <Spinner />
          </span>
        {/if}
        <!-- Refresh -->
        {#if !accountNeedsAttention}
          <Button variant="icon-lg" onclick={handleRefresh} aria-label="Refresh">
            <RefreshCw class="w-4 h-4 {syncing ? 'animate-spin' : ''}" aria-hidden="true" />
          </Button>
        {/if}
        <!-- Settings -->
        <Button variant="icon-lg" onclick={onOpenSettings} aria-label="Open settings">
          <Settings class="w-4 h-4" aria-hidden="true" />
        </Button>
        <!-- Avatar / account switcher -->
        <button
          type="button"
          onclick={() => (accountSwitcherOpen = true)}
          class="ml-0.5 rounded-full hover:opacity-90 transition-opacity focus-visible:ring-1 focus-visible:ring-brand-secondary"
          aria-label="Switch account, currently {activeAccount?.displayName} ({activeAccount?.tenantDisplayName ?? activeAccount?.initialDomain ?? activeAccount?.tenantDomain})"
        >
          {#if activeAccount}
            <Avatar
              displayName={activeAccount.displayName}
              photoDataUrl={activeAccount.photoDataUrl}
              cloud={activeAccount.cloud}
              size="sm"
            />
          {/if}
        </button>
      </div>
    </header>

    <!-- Scrollable main content -->
    {#if accountNeedsAttention && activeAccount}
      <AccountAttentionPage
        account={activeAccount}
        onSignIn={handleSignInAgain}
        onSignOut={openSignOutConfirm}
      />
    {:else}
    <main class="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4">

      <!-- Eligible Activations -->
      <section class="flex flex-col gap-2">
        <button
          type="button"
          onclick={() => (eligibleOpen = !eligibleOpen)}
          aria-expanded={eligibleOpen}
          aria-controls="section-eligible"
          class="section-toggle"
        >
          Eligible Activations
          <ChevronDown class="ml-auto section-toggle-icon text-brand-tertiary {eligibleOpen ? '' : '-rotate-90'}" aria-hidden="true" />
        </button>
        {#if eligibleOpen}
          <div id="section-eligible" class="flex flex-col gap-2" transition:slide={{ duration: 200 }}>
            {#if eligibleEntraRoles.length > 0}
              <div class="flex flex-col gap-1">
                <button
                  type="button"
                  onclick={() => (eligibleEntraOpen = !eligibleEntraOpen)}
                  aria-expanded={eligibleEntraOpen}
                  aria-controls="subsection-entra"
                  class="subsection-toggle"
                >
                  Entra Roles
                  <ChevronDown class="ml-auto section-toggle-icon text-brand-tertiary {eligibleEntraOpen ? '' : '-rotate-90'}" aria-hidden="true" />
                </button>
                {#if eligibleEntraOpen}
                  <div id="subsection-entra" class="flex flex-col gap-1.5" transition:slide={{ duration: 200 }}>
                    <div class="relative">
                      <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-disabled pointer-events-none" aria-hidden="true" />
                      <input type="text" bind:value={entraSearch} placeholder="Filter roles..." aria-label="Filter Entra roles" class="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface-800 border border-surface-600 text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-brand-secondary" />
                    </div>
                    {#each filteredEntraRoles as role (role.id)}
                      <EligibleRoleCard
                        {role}
                        isActivating={activatingRoleIds.has(role.id)}
                        onInfo={() => openDetail({ kind: 'eligible-role', data: role })}
                        onActivate={() => { activationTarget = { kind: 'role', data: role }; activationDialogOpen = true; }}
                      />
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
            {#if azureSubscriptionGroups.length > 0}
              <div class="flex flex-col gap-1">
                <button
                  type="button"
                  onclick={() => (eligibleAzureOpen = !eligibleAzureOpen)}
                  aria-expanded={eligibleAzureOpen}
                  aria-controls="subsection-azure"
                  class="subsection-toggle"
                >
                  Azure
                  <ChevronDown class="ml-auto section-toggle-icon text-brand-tertiary {eligibleAzureOpen ? '' : '-rotate-90'}" aria-hidden="true" />
                </button>
                {#if eligibleAzureOpen}
                  <div id="subsection-azure" class="flex flex-col gap-1.5" transition:slide={{ duration: 200 }}>
                    <div class="relative">
                      <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-disabled pointer-events-none" aria-hidden="true" />
                      <input type="text" bind:value={azureSearch} placeholder="Filter subscriptions..." aria-label="Filter Azure subscriptions" class="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface-800 border border-surface-600 text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-brand-secondary" />
                    </div>
                    {#each filteredAzureGroups as group (group.scopeId)}
                      <Card class="flex items-center justify-between hover:border-surface-500 transition-colors">
                        <div class="flex flex-col min-w-0 gap-1">
                          <span class="text-sm text-text-primary truncate">{group.displayName}</span>
                          {#if group.hasDeepScopes || group.isManagementGroup}
                            <div class="flex gap-1.5">
                              {#if group.isManagementGroup}
                                <Badge color="surface">Management Group</Badge>
                              {/if}
                              {#if group.hasDeepScopes}
                                <Badge color="amber">Deep scope</Badge>
                              {/if}
                            </div>
                          {/if}
                        </div>
                        <div class="flex items-center gap-2 shrink-0 ml-2">
                          <Badge color="brand" pill>{group.eligibleCount}</Badge>
                          <Button
                            variant="icon"
                            onclick={() => (azureDrillTarget = group)}
                            aria-label="View eligible Azure roles in {group.displayName}"
                          >
                            <ChevronRight class="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </Card>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
            {#if eligibleGroups.length > 0}
              <div class="flex flex-col gap-1">
                <button
                  type="button"
                  onclick={() => (eligibleGroupsOpen = !eligibleGroupsOpen)}
                  aria-expanded={eligibleGroupsOpen}
                  aria-controls="subsection-groups"
                  class="subsection-toggle"
                >
                  Groups
                  <ChevronDown class="ml-auto section-toggle-icon text-brand-tertiary {eligibleGroupsOpen ? '' : '-rotate-90'}" aria-hidden="true" />
                </button>
                {#if eligibleGroupsOpen}
                  <div id="subsection-groups" class="flex flex-col gap-1.5" transition:slide={{ duration: 200 }}>
                    <div class="relative">
                      <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-disabled pointer-events-none" aria-hidden="true" />
                      <input type="text" bind:value={groupSearch} placeholder="Filter groups..." aria-label="Filter eligible groups" class="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface-800 border border-surface-600 text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-brand-secondary" />
                    </div>
                    {#each filteredGroups as group (group.id)}
                      <EligibleGroupCard
                        {group}
                        isActivating={activatingGroupIds.has(group.id)}
                        onInfo={() => openDetail({ kind: 'eligible-group', data: group })}
                        onActivate={() => { activationTarget = { kind: 'group', data: group }; activationDialogOpen = true; }}
                      />
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </section>

      <!-- Active Assignments -->
      <section class="flex flex-col gap-2">
        <div class="flex items-center">
          <button
            type="button"
            onclick={() => (activeOpen = !activeOpen)}
            aria-expanded={activeOpen}
            aria-controls="section-active"
            class="section-toggle flex-1"
          >
            Active Assignments
            <ChevronDown class="ml-auto section-toggle-icon text-brand-tertiary {activeOpen ? '' : '-rotate-90'}" aria-hidden="true" />
          </button>
          <Button
            variant="icon"
            onclick={toggleShowPermanent}
            title="{(activeAccount?.showPermanentAssignments ?? false) ? 'Hide' : 'Show'} permanent assignments"
            class="ml-1 shrink-0"
          >
            {#if activeAccount?.showPermanentAssignments ?? false}
              <Eye class="w-3.5 h-3.5 text-text-faint" aria-hidden="true" />
            {:else}
              <EyeOff class="w-3.5 h-3.5 text-text-faint" aria-hidden="true" />
            {/if}
          </Button>
        </div>
        {#if activeOpen}
          <div id="section-active" class="flex flex-col gap-1.5" transition:slide={{ duration: 200 }}>
            <div class="relative">
              <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-disabled pointer-events-none" aria-hidden="true" />
              <input type="text" bind:value={activeSearch} placeholder="Filter assignments..." aria-label="Filter active assignments" class="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface-800 border border-surface-600 text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-brand-secondary" />
            </div>
            {#each filteredActiveAssignments as assignment (assignment.id)}
              <ActiveAssignmentCard
                {assignment}
                onInfo={() => openDetail(
                  'roleName' in assignment
                    ? { kind: 'active-role', data: assignment }
                    : { kind: 'active-group', data: assignment }
                )}
                onDeactivate={handleDeactivate}
              />
            {/each}
          </div>
        {/if}
      </section>

      <!-- Pending Approvals (conditional) -->
      {#if pendingApprovals.length > 0}
        <section class="flex flex-col gap-2">
          <button
            type="button"
            onclick={() => (approvalsOpen = !approvalsOpen)}
            aria-expanded={approvalsOpen}
            aria-controls="section-approvals"
            class="section-toggle"
          >
            <span class="text-status-amber" aria-hidden="true">●</span>
            Pending Approvals
            <Badge color="amber" pill class="ml-auto">{pendingApprovals.length}</Badge>
            <ChevronDown class="section-toggle-icon text-brand-tertiary {approvalsOpen ? '' : '-rotate-90'}" aria-hidden="true" />
          </button>
          {#if approvalsOpen}
            <div id="section-approvals" transition:slide={{ duration: 200 }}>
              <PendingSection
                items={pendingApprovals}
                type="approval"
                onApprovalConfirm={handleApprovalConfirm}
                onApprovalDeny={handleApprovalDeny}
              />
            </div>
          {/if}
        </section>
      {/if}

      <!-- My Pending Requests (conditional) -->
      {#if myPendingRequests.length > 0}
        <section class="flex flex-col gap-2">
          <button
            type="button"
            onclick={() => (requestsOpen = !requestsOpen)}
            aria-expanded={requestsOpen}
            aria-controls="section-requests"
            class="section-toggle"
          >
            <span class="inline-block w-2 h-2 rounded-full border border-brand-tertiary shrink-0" aria-hidden="true"></span>
            My Pending Requests
            <Badge color="surface" pill class="ml-auto">{myPendingRequests.length}</Badge>
            <ChevronDown class="section-toggle-icon text-brand-tertiary {requestsOpen ? '' : '-rotate-90'}" aria-hidden="true" />
          </button>
          {#if requestsOpen}
            <div id="section-requests" transition:slide={{ duration: 200 }}>
              <PendingSection
                items={myPendingRequests}
                type="request"
                onRequestCancel={handleRequestCancel}
              />
            </div>
          {/if}
        </section>
      {/if}

    </main>
    {/if}

    <!-- Account Switcher dialog -->
    <AccountSwitcher
      bind:open={accountSwitcherOpen}
      {accounts}
      activeAccountId={activeAccountId ?? ''}
      onSelect={handleAccountSelect}
      onAddAccount={handleAddAccount}
      onSignOut={openSignOutConfirm}
    />

    <!-- Sign-out confirmation dialog -->
    <SignOutConfirmDialog
      bind:open={signOutConfirmOpen}
      account={signOutTarget}
      onConfirm={handleSignOutConfirmed}
    />

  </div>
{/if}

<!-- Activation dialog rendered outside the view switch so it works from both MainPage and AzureDetailPage -->
<ActivateDialog
  bind:open={activationDialogOpen}
  target={activationTarget}
  onConfirm={handleActivation}
  prefills={justificationPrefills}
  onDeletePrefill={handleDeletePrefill}
/>
