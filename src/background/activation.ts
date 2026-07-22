/**
 * Shared PIM activation request engine.
 *
 * Owns the step-up authentication and error-dispatch logic common to Entra
 * role, group, and Azure ARM activations. Handlers build the request (URL,
 * body, success predicate) and this module drives it to completion.
 */
import type { AccountRecord } from '../tools/db.ts';
import { notify } from '../tools/notify.ts';
import { getArmScopes } from '../tools/oauth.ts';
import { acquireTokenInteractive, acquireSteppedUpToken, tokenSatisfiesPolicy } from './auth.ts';
import { parseGraphError } from './utils.ts';
import { log } from './log.ts';

/**
 * Returns the set of failing rule names from a `RoleAssignmentRequestPolicyValidationFailed`
 * error body, or null when the error is not a policy validation failure.
 */
export function parsePolicyFailure(bodyText: string): string[] | null {
  if (!bodyText.includes('RoleAssignmentRequestPolicyValidationFailed')) return null;
  const rules: string[] = [];
  if (bodyText.includes('MfaRule')) rules.push('MfaRule');
  if (bodyText.includes('AuthenticationContextRule')) rules.push('AuthenticationContextRule');
  if (bodyText.includes('ExpirationRule')) rules.push('ExpirationRule');
  if (bodyText.includes('JustificationRule')) rules.push('JustificationRule');
  if (bodyText.includes('TicketingRule')) rules.push('TicketingRule');
  if (bodyText.includes('EligibilityRule')) rules.push('EligibilityRule');
  return rules.length > 0 ? rules : null;
}

/** Returns true when the error body indicates the token lacks a required auth context claim. */
export function isAcrsValidationFailure(bodyText: string): boolean {
  return bodyText.includes('RoleAssignmentRequestAcrsValidationFailed');
}

/** Outcome of executeActivationRequest: the final response and winning token, or a user-facing error. */
export type ActivationRequestResult =
  | { ok: true; res: Response; token: string }
  | { ok: false; error: string };

/**
 * Shared step-up and error-dispatch engine for PIM activation requests (Entra
 * role, group, and Azure ARM). Handles, in order:
 * 1. Proactive step-up when the cached policy is not satisfied by the token.
 * 2. Reactive acrs (auth context) step-up parsed from the failure body.
 * 3. Reactive MFA/auth-context step-up from policy validation failures.
 * 4. Mapping remaining policy-rule failures to user-facing error messages.
 * On success returns the final response and the token that produced it (which
 * the caller persists if it was elevated).
 * @param opts.resource - 'graph' or 'arm'; selects step-up scopes.
 * @param opts.makeRequest - Issues the activation request with a given token.
 * @param opts.isSuccess - Success predicate (Graph: status 201; ARM: res.ok).
 */
export async function executeActivationRequest(opts: {
  account: AccountRecord;
  resource: 'graph' | 'arm';
  initialToken: string;
  makeRequest: (token: string) => Promise<Response>;
  isSuccess: (res: Response) => boolean;
  cachedPolicy: { mfaRequired: boolean; authContextRequired: boolean; authContextClassRef: string | null } | undefined;
  /** Invoked (fire-and-forget) when a policy validation failure indicates the cached policy is stale. */
  onPolicyStale?: () => Promise<void>;
  logLabel: string;
  failLabel: string;
  notifyLabel: string;
}): Promise<ActivationRequestResult> {
  const { account, resource, makeRequest, isSuccess, cachedPolicy, onPolicyStale, logLabel, failLabel, notifyLabel } = opts;
  let activeToken = opts.initialToken;
  const stepUpScopes = resource === 'arm' ? getArmScopes(account.cloud) : undefined;

  // Proactive step-up: inspect the cached policy before the API call to avoid a wasted round-trip.
  if (cachedPolicy && !tokenSatisfiesPolicy(activeToken, cachedPolicy)) {
    log('info', 'activate', `Proactive step-up for ${logLabel}: policy requires elevated auth`);
    try {
      const stepped = await acquireSteppedUpToken(account, resource, cachedPolicy);
      if (stepped) activeToken = stepped;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log('error', 'activate', `${logLabel} proactive step-up failed: ${error}`);
      return { ok: false, error: `Step-up authentication failed: ${error}` };
    }
  }

  let res = await makeRequest(activeToken);
  if (isSuccess(res)) return { ok: true, res, token: activeToken };

  const failBody = await res.text().catch(() => '(unreadable)');
  const defaultError = `${failLabel} failed (HTTP ${res.status})`;

  // Auth context (acrs) step-up: the token lacks the required Conditional Access claim.
  if (isAcrsValidationFailure(failBody)) {
    log('info', 'activate', `Auth context step-up required for ${logLabel}`);
    let claimsJson: string | undefined;
    const claimsMatch = failBody.match(/claims=(\{[^}]+\})/);
    if (claimsMatch) {
      try { claimsJson = claimsMatch[1]; JSON.parse(claimsJson); } catch { claimsJson = undefined; }
    }
    if (!claimsJson && cachedPolicy?.authContextClassRef) {
      claimsJson = JSON.stringify({ access_token: { acrs: { essential: true, value: cachedPolicy.authContextClassRef } } });
    }
    if (claimsJson) {
      try {
        activeToken = await acquireTokenInteractive(account, claimsJson, stepUpScopes);
        res = await makeRequest(activeToken);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log('error', 'activate', `${logLabel} auth context step-up failed: ${error}`);
        return { ok: false, error: `Auth context step-up failed: ${error}` };
      }
    }
    if (!isSuccess(res)) {
      // When no retry happened the body was already consumed above; reuse it.
      const retryBody = await res.text().catch(() => failBody);
      log('error', 'activate', `${logLabel} failed after auth context step-up: HTTP ${res.status}`);
      const errorMsg = parseGraphError(retryBody, defaultError);
      await notify(notifyLabel, errorMsg);
      return { ok: false, error: errorMsg };
    }
    return { ok: true, res, token: activeToken };
  }

  // Policy validation failure -- dispatch on the specific rule(s) that failed.
  const failedRules = parsePolicyFailure(failBody);
  if (failedRules) {
    // The server disagreed with the cached policy; silently refetch it so the
    // popup shows correct constraints next time (D-b).
    if (onPolicyStale) void onPolicyStale().catch(() => {});
    const needsStepUp = failedRules.includes('MfaRule') || failedRules.includes('AuthenticationContextRule');
    if (needsStepUp) {
      // Build step-up claims from the cached policy or from the rules mentioned in the error.
      const stepUpPolicy = cachedPolicy ?? {
        mfaRequired: failedRules.includes('MfaRule'),
        authContextRequired: false,
        authContextClassRef: null,
      };
      log('info', 'activate', `Step-up required for ${logLabel}: ${failedRules.join(', ')}`);
      try {
        const stepped = await acquireSteppedUpToken(account, resource, stepUpPolicy);
        if (stepped) activeToken = stepped;
        res = await makeRequest(activeToken);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log('error', 'activate', `${logLabel} reactive step-up failed: ${error}`);
        return { ok: false, error: `Step-up authentication failed: ${error}` };
      }
      if (!isSuccess(res)) {
        const retryBody = await res.text().catch(() => '(unreadable)');
        log('error', 'activate', `${logLabel} failed after step-up: HTTP ${res.status} ${retryBody}`);
        const errorMsg = parseGraphError(retryBody, defaultError);
        await notify(notifyLabel, errorMsg);
        return { ok: false, error: errorMsg };
      }
      return { ok: true, res, token: activeToken };
    }
    if (failedRules.includes('ExpirationRule')) {
      return { ok: false, error: 'The requested duration exceeds the maximum allowed by policy.' };
    }
    if (failedRules.includes('JustificationRule')) {
      return { ok: false, error: 'A justification is required to activate this role.' };
    }
    if (failedRules.includes('TicketingRule')) {
      return { ok: false, error: 'A ticket number is required to activate this role.' };
    }
    if (failedRules.includes('EligibilityRule')) {
      return { ok: false, error: 'You are no longer eligible for this role. It may have been removed by an administrator.' };
    }
    const errorMsg = parseGraphError(failBody, defaultError);
    await notify(notifyLabel, errorMsg);
    return { ok: false, error: errorMsg };
  }

  log('error', 'activate', `${logLabel} failed: HTTP ${res.status} ${failBody}`);
  const errorMsg = parseGraphError(failBody, defaultError);
  await notify(notifyLabel, errorMsg);
  return { ok: false, error: errorMsg };
}
