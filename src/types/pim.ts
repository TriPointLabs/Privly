/**
 * Domain model types for Azure PIM (Privileged Identity Management) and
 * Microsoft Entra role/group assignments.
 */

/** Discriminates the level within the Azure resource hierarchy. */
export type AzureScopeKind = 'managementGroup' | 'subscription' | 'resourceGroup' | 'resource';

/**
 * How a principal holds an assignment, from the Graph/ARM `memberType` property:
 * `Direct` (assigned to the principal), `Group` (derived from a group the principal
 * belongs to), or `Inherited` (from a parent scope). PIM-for-Groups never returns
 * `Inherited`. Values are normalized to this canonical casing in the sync layer.
 */
export type MemberType = 'Direct' | 'Group' | 'Inherited';

/**
 * A parsed Azure resource scope with structured fields for each hierarchy level.
 * Produced by `parseAzureScope` in `src/tools/scopeParser.ts`.
 */
export interface AzureScope {
  kind: AzureScopeKind;
  rawScope: string;
  displayName: string;
  managementGroupId?: string;
  subscriptionId?: string;
  subscriptionName?: string;
  resourceGroupName?: string;
  resourceProvider?: string;
  resourceType?: string;
  resourceName?: string;
}

/**
 * PIM policy constraints for a role or group. Derived from the
 * `RoleManagementPolicy` Graph API resource.
 */
export interface PolicyRules {
  /** ISO 8601 duration, e.g. "PT8H". Maximum allowed activation duration. */
  maximumDuration: string;
  mfaRequired: boolean;
  justificationRequired: boolean;
  ticketingRequired: boolean;
  approvalRequired: boolean;
  /** Whether a Conditional Access authentication context is required for activation. */
  authContextRequired: boolean;
  /** The auth context class reference value required (e.g. "c1"), or null when not required. */
  authContextClassRef: string | null;
}

/** A role included in a group's access package, shown in the UI for context. */
export interface IncludedRole {
  id: string;
  displayName: string;
  roleType: 'EntraRole' | 'AzureRole';
}

/** A PIM-eligible role assignment that the user can activate. */
export interface EligibleRole {
  id: string;
  roleName: string;
  isBuiltIn: boolean;
  roleType: 'EntraRole' | 'AzureRole';
  policyRules: PolicyRules;
  /** Present for Azure RBAC roles; absent for Entra directory roles. */
  scope?: AzureScope;
  /** How the eligibility is derived: Direct, via a Group, or Inherited from a parent scope. */
  memberType?: MemberType;
}

/** A PIM-eligible group membership or ownership the user can activate. */
export interface EligibleGroup {
  id: string;
  groupName: string;
  accessId: 'member' | 'owner';
  /** Roles granted transitively via group membership, shown for context. */
  includedRoles: IncludedRole[];
  policyRules: PolicyRules;
  /** How the eligibility is derived: Direct or via a Group. */
  memberType?: MemberType;
}

/** A currently active role assignment with a known expiry. */
export interface ActiveRoleAssignment {
  id: string;
  roleName: string;
  isBuiltIn: boolean;
  roleType: 'EntraRole' | 'AzureRole';
  /** When the activation started. Used to compute the true total duration for the progress bar. */
  startedAt?: Date;
  expiresAt: Date;
  policyRules: PolicyRules;
  scope?: AzureScope;
  /** How the role is held: Direct, via a Group, or Inherited from a parent scope. Undefined until the next sync. */
  memberType?: MemberType;
  /** True when the role is permanently assigned (not PIM-activated). Cannot be deactivated via Privly. */
  isPermanent?: boolean;
}

/** A currently active group membership or ownership with a known expiry. */
export interface ActiveGroupAssignment {
  id: string;
  groupName: string;
  accessId: 'member' | 'owner';
  includedRoles: IncludedRole[];
  /** When the activation started. Used to compute the true total duration for the progress bar. */
  startedAt?: Date;
  expiresAt: Date;
  policyRules: PolicyRules;
  /** How the membership is held: Direct or via a Group. PIM-for-Groups never returns Inherited. */
  memberType?: MemberType;
}

/** Union of all active assignment kinds. */
export type ActiveAssignment = ActiveRoleAssignment | ActiveGroupAssignment;

/**
 * Discriminated union identifying which item the detail panel should display.
 * Used to pass context from the list view to the detail view without a router.
 */
export type DetailTarget =
  | { kind: 'eligible-role'; data: EligibleRole }
  | { kind: 'eligible-group'; data: EligibleGroup }
  | { kind: 'active-role'; data: ActiveRoleAssignment }
  | { kind: 'active-group'; data: ActiveGroupAssignment };

/** A PIM approval request waiting for the current user to approve or deny. */
export interface ApprovalItem {
  id: string;
  roleName: string;
  requestorName: string;
  requestorJustification: string;
  /** ISO 8601 duration, e.g. "PT4H". */
  durationRequested: string;
  requestedAt: Date;
  scope?: AzureScope;
}

/** A PIM activation request submitted by the current user awaiting approval. */
export interface PendingRequest {
  id: string;
  kind: 'role' | 'group';
  roleName: string;
  scope?: AzureScope;
}
