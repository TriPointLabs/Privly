import type { PolicyRules } from '../../types/pim.js';

/** Fallback constraints shown when no cached policy exists for an assignment. */
export const UNKNOWN_POLICY_RULES: PolicyRules = {
  maximumDuration: 'PT8H',
  mfaRequired: false,
  justificationRequired: false,
  ticketingRequired: false,
  approvalRequired: false,
  authContextRequired: false,
  authContextClassRef: null,
};

/**
 * Projects a cached policy record (role, group, or Azure -- all structurally
 * contain the PolicyRules fields) onto the UI's `PolicyRules` shape, falling
 * back to `UNKNOWN_POLICY_RULES` when no policy was cached.
 */
export function toPolicyRules(record: PolicyRules | undefined): PolicyRules {
  if (!record) return UNKNOWN_POLICY_RULES;
  return {
    maximumDuration: record.maximumDuration,
    mfaRequired: record.mfaRequired,
    justificationRequired: record.justificationRequired,
    ticketingRequired: record.ticketingRequired,
    approvalRequired: record.approvalRequired,
    authContextRequired: record.authContextRequired,
    authContextClassRef: record.authContextClassRef,
  };
}
