import type { MemberType } from '../types/pim';

/**
 * Normalizes the raw `memberType` from Graph or ARM into the canonical casing used
 * throughout the app. Entra and ARM return capitalized values (`Direct`/`Group`/`Inherited`),
 * while PIM-for-Groups returns lowercase (`direct`/`group`). `unknownFutureValue` and any
 * unrecognized value map to undefined so the UI simply shows no badge.
 */
export function normalizeMemberType(raw?: string): MemberType | undefined {
  switch (raw?.toLowerCase()) {
    case 'direct': return 'Direct';
    case 'group': return 'Group';
    case 'inherited': return 'Inherited';
    default: return undefined;
  }
}
