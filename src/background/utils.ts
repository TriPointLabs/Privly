/**
 * Shared utilities for the Privly service worker.
 *
 * Contains stateless helpers, typed notification wrappers, and Graph API error
 * parsing. All exports are side-effect-free and have no background-module
 * dependencies -- they can be imported by any module without risk of circular
 * references.
 */
import { sendNotification, type StoreName } from '../types/messages.js';
import { log } from './log.ts';
import type { PolicyRules } from '../types/pim.js';

/** @internal Raw rule shape returned by the Graph `roleManagementPolicies/{id}/rules` endpoint. */
export interface RawPolicyRule {
  id: string;
  maximumDuration?: string;
  isExpirationRequired?: boolean;
  enabledRules?: string[];
  setting?: { isApprovalRequired?: boolean };
  /** Present on AuthenticationContext rules: whether the rule is active. */
  isEnabled?: boolean;
  /** Present on AuthenticationContext rules: the required auth context class reference (e.g. "c1"). */
  claimValue?: string;
}

/** Activating records older than this threshold are treated as stale (service worker was killed mid-poll). */
export const ACTIVATING_STALE_TTL_MS = 2 * 60 * 1000;

/** Status values returned by Graph PIM that indicate provisioning is still in progress. */
export const PENDING_ACTIVATION_STATUSES = new Set([
  'Accepted', 'PendingEvaluation', 'PendingProvisioning',
  'ProvisioningStarted', 'PendingScheduleCreation', 'PendingExternalProvisioning',
]);

/**
 * Sends a `DB_CHANGED` notification to the popup. Fire-and-forget -- the popup
 * may not be open, so errors are silently swallowed.
 * @param stores - One or more store names that were modified.
 */
export function notifyDbChanged(...stores: StoreName[]): void {
  sendNotification({ type: 'DB_CHANGED', stores });
}

/**
 * Extracts a human-readable error message from a Graph API JSON error body.
 * Attempts to read `error.message` then `error.code`. Returns `fallback` if
 * the body is not valid JSON or neither field is present.
 * @param bodyText - Raw response body text from a failed Graph request.
 * @param fallback - Error string to use when no structured error can be parsed.
 */
export function parseGraphError(bodyText: string, fallback: string): string {
  try {
    const j = JSON.parse(bodyText);
    return j.error?.message ?? j.error?.code ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Processes items with bounded concurrency. Runs up to `concurrency` items in
 * parallel at a time using `Promise.all`, then waits for the whole batch to
 * settle before starting the next batch.
 * @param items - Array of items to process.
 * @param concurrency - Maximum number of items to process simultaneously.
 * @param fn - Async function to run for each item.
 */
export async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn));
  }
}

/**
 * Wraps fetch with bounded retries (max 2). HTTP 429 is always retried,
 * honoring the `Retry-After` header (+1s padding, 5s default). HTTP 5xx and
 * network errors are retried only for idempotent (GET) requests -- a POST/PUT
 * that died mid-flight may already have been applied server-side, so retrying
 * it could duplicate the action. Backoff without Retry-After is 1s then 4s.
 * @param url - Request URL.
 * @param init - Standard `RequestInit` options forwarded to `fetch`.
 */
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const maxRetries = 2;
  const idempotent = !init.method || init.method.toUpperCase() === 'GET';
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (!idempotent || attempt >= maxRetries) throw e;
    }
    if (res) {
      const retryable = res.status === 429 || (res.status >= 500 && idempotent);
      if (!retryable || attempt >= maxRetries) return res;
    }
    const retryAfter = res?.status === 429 ? parseInt(res.headers.get('Retry-After') ?? '5', 10) + 1 : NaN;
    const delaySec = Number.isFinite(retryAfter) ? retryAfter : 4 ** attempt;
    log('warn', 'general', `${res ? `HTTP ${res.status}` : 'Network error'} from ${url.split('?')[0]}, retry ${attempt + 1}/${maxRetries} in ${delaySec}s`);
    await new Promise(resolve => setTimeout(resolve, delaySec * 1_000));
  }
}

/**
 * Returns true when `candidate` parses as a URL on exactly `origin`.
 * An unparseable link is treated as off-origin so it is never followed.
 */
function isSameOrigin(candidate: string, origin: string): boolean {
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}

/** Result of a paginated list fetch: all pages' items, or the first failing response. */
export type PagedResult<T> =
  | { ok: true; items: T[] }
  | { ok: false; status: number; body: string };

/**
 * Fetches every page of a Graph or ARM list endpoint via `fetchWithRetry`,
 * following `@odata.nextLink` (Graph) or `nextLink` (ARM) until exhausted.
 * A page failure fails the whole call so callers never act on partial data.
 * `maxPages` bounds a pathological response chain; hitting it is logged loudly
 * rather than silently truncating.
 *
 * The continuation link is chosen by the server but is followed with the
 * caller's `Authorization` header attached, so a link pointing off-origin would
 * hand a privileged bearer token to another host. Unlike an HTTP redirect --
 * where the Fetch spec strips `Authorization` cross-origin -- this request is
 * built here, so nothing strips it for us. Pagination therefore stops at the
 * first link whose origin differs from the first page's.
 * @param url - First page URL (with query parameters).
 * @param init - Standard `RequestInit` forwarded to every page request.
 * @param maxPages - Upper bound on pages to follow. Defaults to 20.
 */
export async function fetchAllPages<T>(url: string, init: RequestInit, maxPages = 20): Promise<PagedResult<T>> {
  const items: T[] = [];
  const origin = new URL(url).origin;
  let next: string | undefined = url;
  for (let page = 0; next && page < maxPages; page++) {
    const res = await fetchWithRetry(next, init);
    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      return { ok: false, status: res.status, body };
    }
    const json = await res.json() as { value?: T[]; '@odata.nextLink'?: string; nextLink?: string };
    items.push(...(json.value ?? []));

    const link = json['@odata.nextLink'] ?? json.nextLink;
    if (link && !isSameOrigin(link, origin)) {
      log('error', 'general', `Refusing cross-origin continuation link from ${origin}; results are incomplete`);
      return { ok: true, items };
    }
    next = link;
  }
  if (next) {
    log('warn', 'general', `fetchAllPages hit the ${maxPages}-page cap for ${url.split('?')[0]} -- results are incomplete`);
  }
  return { ok: true, items };
}

/**
 * Polls a PIM schedule request GET endpoint at `intervalMs` intervals until its
 * `status` field exits the transitional set. Returns the final status string, or
 * `'Unknown'` if the request fails or the attempt limit is reached so callers
 * can always proceed to sync regardless of polling outcome.
 * @param requestUrl - Full URL of the schedule request resource to GET.
 * @param token - Bearer token for the request.
 * @param intervalMs - Milliseconds between poll attempts. Defaults to 3000.
 * @param maxAttempts - Maximum number of poll attempts before giving up. Defaults to 8.
 * @param extractStatus - Reads the status from a response body. Defaults to the Graph shape (`body.status`); ARM callers pass `body.properties.status`.
 */
export async function pollUntilProvisioned(
  requestUrl: string,
  token: string,
  intervalMs = 3000,
  maxAttempts = 8,
  extractStatus: (body: unknown) => string | undefined = body => (body as { status?: string }).status,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const res = await fetch(requestUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) break;
      const status = extractStatus(await res.json());
      if (status && !PENDING_ACTIVATION_STATUSES.has(status)) return status;
    } catch { break; }
  }
  return 'Unknown';
}

/**
 * Parses the three end-user assignment rules from a raw policy rules array.
 * Matches by stable rule ID strings (not `@odata.type`). Returns sensible
 * defaults when a rule is absent from the policy.
 * @param rules - Raw rule array from the `roleManagementPolicies/{id}/rules` endpoint.
 */
export function parsePolicyRules(rules: RawPolicyRule[]): PolicyRules {
  const expiration  = rules.find(r => r.id === 'Expiration_EndUser_Assignment');
  const enablement  = rules.find(r => r.id === 'Enablement_EndUser_Assignment');
  const approval    = rules.find(r => r.id === 'Approval_EndUser_Assignment');
  const authContext = rules.find(r => r.id === 'AuthenticationContext_EndUser_Assignment');
  const enabled = enablement?.enabledRules ?? [];
  const acrsEnabled = authContext?.isEnabled === true && !!authContext?.claimValue;
  return {
    maximumDuration:       expiration?.maximumDuration ?? 'PT8H',
    mfaRequired:           enabled.includes('MultiFactorAuthentication'),
    justificationRequired: enabled.includes('Justification'),
    ticketingRequired:     enabled.includes('Ticketing'),
    approvalRequired:      approval?.setting?.isApprovalRequired ?? false,
    authContextRequired:   acrsEnabled,
    authContextClassRef:   acrsEnabled ? authContext!.claimValue! : null,
  };
}
