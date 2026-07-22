import type { AzureScope, AzureScopeKind } from '../types/pim.js';

export type { AzureScope, AzureScopeKind };

/**
 * Parses an Azure resource scope path into a structured `AzureScope` object.
 *
 * Recognized patterns (case-insensitive):
 * - Management group: `/providers/Microsoft.Management/managementGroups/{id}`
 * - Resource: `/subscriptions/{sub}/resourceGroups/{rg}/providers/{ns}/{type}/{name}`
 * - Resource group: `/subscriptions/{sub}/resourceGroups/{rg}`
 * - Subscription: `/subscriptions/{sub}`
 *
 * Unrecognized paths fall back to `kind: 'subscription'` with only `rawScope`
 * and `displayName` populated.
 * @param rawScope - The raw Azure resource scope path (e.g. `/subscriptions/{id}`).
 * @param displayName - Human-readable label for the scope, used as the fallback display value.
 * @returns A structured `AzureScope` object with all recognized path segments extracted.
 */
export function parseAzureScope(rawScope: string, displayName: string): AzureScope {
  // Management group: /providers/Microsoft.Management/managementGroups/{id}
  const mgMatch = rawScope.match(/^\/providers\/Microsoft\.Management\/managementGroups\/([^/]+)$/i);
  if (mgMatch) {
    return { kind: 'managementGroup', rawScope, displayName, managementGroupId: mgMatch[1] };
  }

  // Resource: /subscriptions/{sub}/resourceGroups/{rg}/providers/{ns}/{type}/{name}
  const resourceMatch = rawScope.match(
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/([^/]+)\/([^/]+)\/([^/]+)$/i
  );
  if (resourceMatch) {
    return {
      kind: 'resource',
      rawScope,
      displayName,
      subscriptionId: resourceMatch[1],
      resourceGroupName: resourceMatch[2],
      resourceProvider: resourceMatch[3],
      resourceType: resourceMatch[4],
      resourceName: resourceMatch[5],
    };
  }

  // Resource group: /subscriptions/{sub}/resourceGroups/{rg}
  const rgMatch = rawScope.match(/^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)$/i);
  if (rgMatch) {
    return {
      kind: 'resourceGroup',
      rawScope,
      displayName,
      subscriptionId: rgMatch[1],
      resourceGroupName: rgMatch[2],
    };
  }

  // Subscription: /subscriptions/{sub}
  const subMatch = rawScope.match(/^\/subscriptions\/([^/]+)$/i);
  if (subMatch) {
    return { kind: 'subscription', rawScope, displayName, subscriptionId: subMatch[1] };
  }

  // Fallback
  return { kind: 'subscription', rawScope, displayName };
}

/**
 * Returns a concise display string for an `AzureScope` suitable for use in
 * list items and detail panels.
 *
 * - Management group / subscription: uses `displayName` directly.
 * - Resource group: prefixes the resource group name when available.
 * - Resource: formats as `name (provider/type)` when all fields are present.
 * @param scope - The parsed `AzureScope` to format.
 * @returns A concise display string suitable for list items and detail panels.
 */
export function formatScopeLabel(scope: AzureScope): string {
  switch (scope.kind) {
    case 'managementGroup':
      return scope.displayName;
    case 'subscription':
      return scope.displayName;
    case 'resourceGroup':
      return scope.resourceGroupName
        ? `${scope.resourceGroupName} · ${scope.displayName}`
        : scope.displayName;
    case 'resource':
      return scope.resourceName && scope.resourceProvider && scope.resourceType
        ? `${scope.resourceName} (${scope.resourceProvider}/${scope.resourceType})`
        : scope.displayName;
  }
}
