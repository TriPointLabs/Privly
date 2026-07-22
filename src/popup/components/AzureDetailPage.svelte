<script lang="ts">
  /**
   * Hierarchical drill-down page for Azure ARM eligible roles.
   *
   * Each level shows two sections:
   * 1. Roles assigned at the current scope level (e.g. subscription-level roles)
   * 2. Child scopes that contain deeper roles (e.g. resource groups under a subscription),
   *    each with a drill button to navigate deeper
   *
   * Navigation is managed via an internal scope stack. The initial scope comes from
   * MainPage (a subscription or management group). Drilling into a child scope pushes
   * it onto the stack; the back button pops it. When the stack is empty, onBack returns
   * to MainPage.
   *
   * Management groups are leaf-level only -- the ARM API surfaces them when the user has
   * a direct assignment, not for child subscriptions within the MG.
   */
  import { onDestroy } from 'svelte';
  import { slide } from 'svelte/transition';
  import EligibleRoleCard from './EligibleRoleCard.svelte';
  import DetailPage from './DetailPage.svelte';
  import { Button, Badge } from './ui/index.js';
  import { ChevronLeft, ChevronRight, Search } from '@lucide/svelte';
  import type { EligibleRole, DetailTarget, AzureScopeKind } from '../../types/pim';
  import { type AzureRoleRecord, type AzurePolicyRecord } from '../../tools/db.js';
  import { loadAzureScopeDetail } from '../data.js';
  import { parseAzureScope } from '../../tools/scopeParser.js';
  import { toPolicyRules } from '../utils/policy.js';
  import browser from 'webextension-polyfill';
  import type { StoreName } from '../../types/messages.js';

  let { scopeId: initialScopeId, accountId, displayName: initialDisplayName, isManagementGroup, activatingAzureRoleIds = new Set<string>(), onBack, onActivate }: {
    scopeId: string;
    accountId: string;
    displayName: string;
    isManagementGroup: boolean;
    activatingAzureRoleIds?: Set<string>;
    onBack: () => void;
    onActivate: (role: EligibleRole) => void;
  } = $props();

  // ---------------------------------------------------------------------------
  // Navigation state
  // ---------------------------------------------------------------------------

  /** A level in the drill-down stack. */
  interface ScopeLevel {
    scopeId: string;
    displayName: string;
    scopeType: AzureScopeKind;
  }

  let scopeStack = $state<ScopeLevel[]>([]);
  let detailTarget = $state<DetailTarget | null>(null);
  let searchQuery = $state('');

  const currentLevel = $derived<ScopeLevel>(
    scopeStack.length > 0
      ? scopeStack[scopeStack.length - 1]
      : { scopeId: initialScopeId, displayName: initialDisplayName, scopeType: isManagementGroup ? 'managementGroup' as const : 'subscription' as const }
  );

  function drillInto(child: ChildScope) {
    scopeStack = [...scopeStack, { scopeId: child.scopeId, displayName: child.displayName, scopeType: child.scopeType }];
    searchQuery = '';
  }

  function handleBack() {
    if (detailTarget) {
      detailTarget = null;
    } else if (scopeStack.length > 0) {
      scopeStack = scopeStack.slice(0, -1);
      searchQuery = '';
    } else {
      onBack();
    }
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  /** All eligible role records for this account (filtered by top-level scope). */
  let allEligible = $state<AzureRoleRecord[]>([]);
  let scopeNameMap = $state(new Map<string, string>());
  let scopeTypeMap = $state(new Map<string, AzureScopeKind>());
  /** Policy cache keyed by `${scopeId}::${roleDefinitionId}`. */
  let policyCache = $state(new Map<string, AzurePolicyRecord>());

  // Named listener + onDestroy removal: this component mounts once per drill-in,
  // so an anonymous listener would leak (and re-run refreshData N times) after
  // repeated navigation.
  const onDbChanged = (message: { type: string; stores?: StoreName[] }) => {
    if (message.type !== 'DB_CHANGED') return;
    const stores = message.stores ?? [];
    if (stores.includes('azure_roles') || stores.includes('azure_scopes') || stores.includes('azure_activations') || stores.includes('azure_policies')) {
      refreshData();
    }
  };
  browser.runtime.onMessage.addListener(onDbChanged);
  onDestroy(() => browser.runtime.onMessage.removeListener(onDbChanged));

  /**
   * Loads all eligible roles under the top-level scope, scope metadata, and
   * policy rules via the index-backed data layer. Called on mount and on DB_CHANGED.
   */
  async function refreshData() {
    const detail = await loadAzureScopeDetail(accountId, initialScopeId, isManagementGroup);
    allEligible = detail.eligible;
    scopeNameMap = detail.scopeNameMap;
    scopeTypeMap = detail.scopeTypeMap;
    policyCache = detail.policies;
  }

  refreshData();

  // ---------------------------------------------------------------------------
  // Derived: roles at current scope + child scopes with deeper roles
  // ---------------------------------------------------------------------------

  function toEligibleRole(r: AzureRoleRecord): EligibleRole {
    return {
      id: r.id,
      roleName: r.roleDisplayName,
      isBuiltIn: r.roleIsBuiltIn,
      roleType: 'AzureRole' as const,
      memberType: r.memberType,
      scope: parseAzureScope(r.scopeId, scopeNameMap.get(r.scopeId) ?? r.scopeId),
      policyRules: toPolicyRules(policyCache.get(`${r.scopeId}::${r.roleDefinitionId}`)),
    };
  }

  /** Roles assigned at the exact current scope level (not deeper). */
  const rolesAtCurrentScope = $derived(
    allEligible.filter(r => r.scopeId === currentLevel.scopeId).map(toEligibleRole)
  );

  /** Child scope summary for the "deeper roles" menu. */
  interface ChildScope {
    scopeId: string;
    displayName: string;
    scopeType: AzureScopeKind;
    eligibleCount: number;
  }

  /**
   * Groups roles that are deeper than the current scope into child scope rows.
   * For a subscription: groups by resource group path.
   * For a resource group: groups by resource path.
   */
  const childScopes = $derived.by(() => {
    const curId = currentLevel.scopeId;
    const curType = currentLevel.scopeType;

    // Roles deeper than the current scope: their scopeId starts with the current
    // scope path but is not equal to it.
    const deeperRoles = allEligible.filter(r =>
      r.scopeId !== curId && r.scopeId.toLowerCase().startsWith(curId.toLowerCase() + '/')
    );
    if (deeperRoles.length === 0) return [];

    // Determine the immediate child scope for each deeper role.
    // For subscription -> resourceGroup: extract /subscriptions/{id}/resourceGroups/{rg}
    // For resourceGroup -> resource: extract the full resource path
    const childMap = new Map<string, ChildScope>();

    for (const role of deeperRoles) {
      let childKey: string;

      if (curType === 'subscription') {
        // Child is the resource group segment: /subscriptions/{id}/resourceGroups/{rg}
        const rgMatch = role.scopeId.match(/^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+)/i);
        childKey = rgMatch ? rgMatch[1] : role.scopeId;
      } else if (curType === 'resourceGroup') {
        // Child is the full resource path (one level deeper)
        childKey = role.scopeId;
      } else {
        // MG or resource -- no children expected
        childKey = role.scopeId;
      }

      const existing = childMap.get(childKey);
      if (existing) {
        existing.eligibleCount++;
      } else {
        const childType = scopeTypeMap.get(childKey) ?? (curType === 'subscription' ? 'resourceGroup' : 'resource');
        childMap.set(childKey, {
          scopeId: childKey,
          displayName: scopeNameMap.get(childKey) ?? childKey.split('/').pop() ?? childKey,
          scopeType: childType,
          eligibleCount: 1,
        });
      }
    }

    return [...childMap.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  });

  /** Child scopes filtered by the search query. */
  const filteredChildren = $derived(
    searchQuery.trim() === ''
      ? childScopes
      : childScopes.filter(c => c.displayName.toLowerCase().includes(searchQuery.trim().toLowerCase()))
  );

  const scopeTypeLabel = $derived(
    currentLevel.scopeType === 'managementGroup' ? 'Management Group' :
    currentLevel.scopeType === 'subscription' ? 'Subscription' :
    currentLevel.scopeType === 'resourceGroup' ? 'Resource Group' : 'Resource'
  );

  const childScopeTypeLabel = $derived(
    currentLevel.scopeType === 'subscription' ? 'Resource Groups' :
    currentLevel.scopeType === 'resourceGroup' ? 'Resources' : 'Child Scopes'
  );

  const totalEligible = $derived(rolesAtCurrentScope.length + childScopes.reduce((sum, c) => sum + c.eligibleCount, 0));
</script>

{#if detailTarget}
  <DetailPage target={detailTarget} onBack={() => (detailTarget = null)} />
{:else}
  <div class="flex flex-col h-full bg-surface-900 text-text-primary">
    <!-- Header -->
    <header class="flex items-center gap-3 px-4 h-12 bg-surface-800 border-b border-surface-700 shrink-0">
      <Button variant="icon" onclick={handleBack} aria-label={scopeStack.length > 0 ? 'Back to parent scope' : 'Back to main page'}>
        <ChevronLeft class="w-4 h-4" aria-hidden="true" />
      </Button>
      <div class="flex flex-col min-w-0 flex-1">
        <h1 class="text-sm font-semibold text-text-primary truncate">{currentLevel.displayName}</h1>
        <span class="text-[10px] text-text-faint">{scopeTypeLabel} -- {totalEligible} eligible</span>
      </div>
    </header>

    <!-- Scrollable content -->
    <main class="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4">

      {#if rolesAtCurrentScope.length === 0 && childScopes.length === 0}
        <p class="text-sm text-text-faint text-center py-8">No eligible roles in this scope</p>
      {/if}

      <!-- Roles at this exact scope level -->
      {#if rolesAtCurrentScope.length > 0}
        <section class="flex flex-col gap-1.5">
          <h2 class="text-[10px] font-semibold text-text-faint uppercase tracking-wider px-1">
            {scopeTypeLabel} Roles
          </h2>
          {#each rolesAtCurrentScope as role (role.id)}
            <div transition:slide={{ duration: 150 }}>
              <EligibleRoleCard
                {role}
                isActivating={activatingAzureRoleIds.has(role.id)}
                onInfo={() => (detailTarget = { kind: 'eligible-role', data: role })}
                onActivate={() => onActivate(role)}
              />
            </div>
          {/each}
        </section>
      {/if}

      <!-- Child scopes with deeper roles -->
      {#if childScopes.length > 0}
        <section class="flex flex-col gap-1.5">
          <h2 class="text-[10px] font-semibold text-text-faint uppercase tracking-wider px-1">
            {childScopeTypeLabel}
          </h2>

          <!-- Search filter -->
          <div class="relative">
            <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-disabled pointer-events-none" aria-hidden="true" />
            <input
              type="text"
              bind:value={searchQuery}
              placeholder="Filter {childScopeTypeLabel.toLowerCase()}..."
              aria-label="Filter {childScopeTypeLabel.toLowerCase()}"
              class="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface-800 border border-surface-600 text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-brand-secondary"
            />
          </div>

          {#if filteredChildren.length === 0}
            <p class="text-xs text-text-disabled text-center py-3">No matches</p>
          {:else}
            {#each filteredChildren as child (child.scopeId)}
              <button
                type="button"
                onclick={() => drillInto(child)}
                class="w-full text-left px-3 py-2.5 rounded-lg bg-surface-800 border border-surface-600 hover:border-surface-500 transition-colors flex items-center justify-between"
                aria-label="Drill into {child.displayName}, {child.eligibleCount} eligible"
              >
                <div class="flex flex-col min-w-0 gap-0.5">
                  <span class="text-sm text-text-primary truncate">{child.displayName}</span>
                  {#if child.scopeType === 'resource'}
                    <span class="text-[10px] text-text-disabled truncate">{child.scopeId.split('/providers/')[1] ?? ''}</span>
                  {/if}
                </div>
                <div class="flex items-center gap-2 shrink-0 ml-2">
                  <Badge color="brand" pill>{child.eligibleCount}</Badge>
                  <ChevronRight class="w-4 h-4 text-text-faint" aria-hidden="true" />
                </div>
              </button>
            {/each}
          {/if}
        </section>
      {/if}

    </main>
  </div>
{/if}
