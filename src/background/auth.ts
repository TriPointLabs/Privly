/**
 * Authentication and token lifecycle management.
 *
 * Owns all interactions with the Microsoft identity platform: initial sign-in
 * (PKCE), silent token refresh (refresh token grant and silent SSO fallback),
 * ARM token acquisition, and account attention state. All writes to the `accounts`
 * store happen here.
 */
import { decodeJwt } from 'jose';
import browser from 'webextension-polyfill';
import { getDB, type AccountRecord } from '../tools/db.ts';
import { notify } from '../tools/notify.ts';
import {
  discoverCloud,
  getClientId,
  getScopes,
  getArmScopes,
  fetchArmAccessToken,
  generatePKCEPair,
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  verifyIdToken,
  type TokenSet,
} from '../tools/oauth.ts';
import { notifyDbChanged } from './utils.ts';
import { log, maskUpn } from './log.ts';

/**
 * Downloads the account's 120x120 profile photo from Microsoft Graph and returns it as a base64 data URL,
 * or null if unavailable.
 *
 * @param graphHost - The Graph API base URL for the account's cloud (e.g. `https://graph.microsoft.com`).
 * @param accessToken - A valid bearer token with `User.Read` scope.
 * @returns A `data:image/jpeg;base64,...` URL, or `null` if the photo is missing or the request fails.
 */
export async function fetchAccountPhoto(graphHost: string, accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${graphHost}/v1.0/me/photos/120x120/$value`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

/**
 * Queries the Graph `/organization` endpoint for the tenant's initial domain and display name.
 * Used to show a canonical tenant identifier and human-readable name in the UI, independent of the
 * UPN domain and correct for B2B guest accounts. Returns nulls on any error.
 *
 * @param graphHost - The Graph API base URL for the account's cloud.
 * @param accessToken - A valid bearer token with `Organization.Read.All` or equivalent scope.
 * @returns The initial domain (e.g. `contoso.onmicrosoft.com`) and tenant display name (e.g. `Contoso Corporation`), or nulls on any error.
 */
export async function fetchTenantInfo(
  graphHost: string,
  accessToken: string
): Promise<{ initialDomain: string | null; tenantDisplayName: string | null }> {
  try {
    const res = await fetch(
      `${graphHost}/v1.0/organization?$select=verifiedDomains,displayName`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return { initialDomain: null, tenantDisplayName: null };
    const json = await res.json();
    const org = json.value?.[0];
    const domains: Array<{ name: string; isInitial: boolean }> = org?.verifiedDomains ?? [];
    return {
      initialDomain: domains.find(d => d.isInitial)?.name ?? null,
      tenantDisplayName: org?.displayName ?? null,
    };
  } catch {
    return { initialDomain: null, tenantDisplayName: null };
  }
}

/**
 * Runs one OAuth2 authorization-code + PKCE flow via `launchWebAuthFlow` and
 * exchanges the resulting code for tokens. Shared by interactive sign-in,
 * interactive step-up, and the silent-SSO refresh fallbacks -- the callers
 * differ only in endpoints, scopes, interactivity, and how tokens are persisted.
 * @throws On state mismatch (CSRF guard), missing authorization code, or token-endpoint errors.
 */
async function runAuthCodeFlow(params: {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
  interactive: boolean;
  loginHint?: string;
  claimsJson?: string;
  prompt?: string;
}): Promise<TokenSet> {
  const { authorizationEndpoint, tokenEndpoint, clientId, scopes, interactive, loginHint, claimsJson, prompt } = params;
  const { verifier, challenge } = await generatePKCEPair();
  const state = crypto.randomUUID();
  const redirectUri = browser.identity.getRedirectURL();
  const authUrl = buildAuthUrl({ authorizationEndpoint, clientId, redirectUri, scopes, state, challenge, loginHint, claimsJson, prompt });
  const responseUrl = await browser.identity.launchWebAuthFlow({ url: authUrl, interactive });
  const responseParams = new URL(responseUrl).searchParams;
  if (responseParams.get('state') !== state) throw new Error('State mismatch -- possible CSRF');
  const code = responseParams.get('code');
  if (!code) throw new Error(responseParams.get('error_description') ?? 'No authorization code in response');
  return exchangeCodeForTokens({ tokenEndpoint, clientId, code, redirectUri, verifier, scopes, claimsJson });
}

/**
 * Marks an account as needing user attention by writing a `needsAttention` reason to IndexedDB and notifying the popup via `DB_CHANGED`.
 *
 * AADSTS50058 and "interaction required" errors are translated to a user-friendly message; all other error strings are stored verbatim.
 *
 * @param db - An open IndexedDB connection to write the updated account record.
 * @param account - The account to mark; the existing record is spread and `needsAttention` is overwritten.
 * @param error - The raw error message; recognized AADSTS codes are replaced with a friendly string.
 */
export async function markNeedsAttention(
  db: Awaited<ReturnType<typeof getDB>>,
  account: AccountRecord,
  error: string
): Promise<void> {
  const reason = error.includes('interaction required') || error.includes('AADSTS50058')
    ? 'Session expired. Sign in again to restore access.'
    : error;
  // Re-read before writing so a stale caller snapshot cannot clobber fields
  // written concurrently (e.g. a step-up token persist).
  const fresh = await db.get('accounts', account.id) ?? account;
  log('error', 'account', `Account ${maskUpn(account.userPrincipalName)} needs attention: ${reason}`);
  await db.put('accounts', { ...fresh, needsAttention: { reason } });
  // Only notify on the first failure. If needsAttention was already set, the user
  // was already notified; repeated failures (or retries) should not re-alert.
  if (!fresh.needsAttention) {
    await notify(`Action Required: ${maskUpn(account.userPrincipalName)}`, reason);
  }
  notifyDbChanged('accounts');
}

/**
 * Attempts to silently acquire or refresh an ARM-scoped access token for the account identified
 * by `accountId`. Skips if the token is still valid for more than 10 minutes.
 *
 * Uses a two-tier strategy:
 * 1. Refresh token grant -- fast, no user interaction.
 * 2. Silent SSO via `launchWebAuthFlow({ interactive: false })` -- fallback if the refresh token grant fails.
 *
 * Failures are reported via `markNeedsAttention` so the user is prompted to sign in interactively.
 * If `fatal` is false (e.g. during initial sign-in), failures are only logged.
 * @param accountId - The local UUID of the account to refresh ARM tokens for.
 * @param db - Open IndexedDB connection.
 * @param options.fatal - If true (default), ARM failures call markNeedsAttention. If false, failures are logged only.
 */
export async function refreshArmToken(
  accountId: string,
  db: Awaited<ReturnType<typeof getDB>>,
  { fatal = true }: { fatal?: boolean } = {}
): Promise<void> {
  const account = await db.get('accounts', accountId);
  if (!account) return;

  const minsUntilArmExpiry = account.armTokenExpiresAt != null
    ? Math.round((account.armTokenExpiresAt - Date.now()) / 60_000)
    : null;
  if (minsUntilArmExpiry != null && minsUntilArmExpiry > 10) {
    log('info', 'auth', `ARM token for ${maskUpn(account.userPrincipalName)} still valid (expires in ~${minsUntilArmExpiry} min), skipping`);
    return;
  }

  if (!account.refreshToken || !account.tokenEndpoint || !account.loginHost || !account.cloud) {
    log('info', 'auth', `refreshArmToken skipped for ${maskUpn(account.userPrincipalName)}: missing required fields`);
    return;
  }

  log('info', 'auth', `Acquiring ARM token for ${maskUpn(account.userPrincipalName)}`);
  const clientId = getClientId(account.cloud);

  // Tier 1: refresh token grant
  try {
    const armTokens = await fetchArmAccessToken({
      tokenEndpoint: account.tokenEndpoint,
      clientId,
      refreshToken: account.refreshToken,
      cloud: account.cloud,
    });
    const fresh = await db.get('accounts', accountId);
    if (!fresh) return;
    await db.put('accounts', { ...fresh, armAccessToken: armTokens.accessToken, armTokenExpiresAt: armTokens.tokenExpiresAt });
    notifyDbChanged('accounts');
    log('info', 'auth', `ARM token acquired for ${maskUpn(account.userPrincipalName)}`);
    return;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log('warn', 'auth', `ARM refresh token grant failed for ${maskUpn(account.userPrincipalName)}: ${error}`);
    if (error.includes('AADSTS65001')) {
      if (fatal) {
        const fresh2 = await db.get('accounts', accountId);
        if (fresh2) await markNeedsAttention(db, fresh2, `ARM token: ${error}`);
      }
      return;
    }
  }

  // Tier 2: silent SSO via launchWebAuthFlow. Only armAccessToken is retained.
  try {
    const armTokens = await runAuthCodeFlow({
      authorizationEndpoint: `${account.loginHost}/${account.tenantId}/oauth2/v2.0/authorize`,
      tokenEndpoint: account.tokenEndpoint,
      clientId,
      scopes: getArmScopes(account.cloud),
      interactive: false,
      loginHint: account.userPrincipalName,
      prompt: 'none',
    });
    const fresh3 = await db.get('accounts', accountId);
    if (!fresh3) return;
    await db.put('accounts', { ...fresh3, armAccessToken: armTokens.accessToken, armTokenExpiresAt: armTokens.tokenExpiresAt });
    notifyDbChanged('accounts');
    log('info', 'auth', `ARM token acquired via silent SSO for ${maskUpn(account.userPrincipalName)}`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log('warn', 'auth', `ARM silent SSO failed for ${maskUpn(account.userPrincipalName)}: ${error}`);
    if (fatal) {
      const fresh4 = await db.get('accounts', accountId);
      if (fresh4) await markNeedsAttention(db, fresh4, `ARM token refresh failed: ${error}`);
    }
  }
}

/**
 * Attempts to silently refresh tokens for `account` if they expire within 10 minutes. Uses a two-tier strategy:
 *
 * 1. Refresh token grant -- fast, no user interaction.
 * 2. Silent SSO via `launchWebAuthFlow({ interactive: false })` -- re-runs OpenID Connect with `prompt=none` to obtain a fresh code. Falls back to this only when the refresh token grant fails with a non-consent error.
 *
 * On unrecoverable failure, calls `markNeedsAttention` so the UI can prompt the user to sign in interactively.
 *
 * @param account - The account whose tokens should be refreshed.
 */
export async function refreshAccountTokens(account: AccountRecord): Promise<void> {
  if (!account.refreshToken || !account.tokenEndpoint || !account.tokenExpiresAt) {
    log('info', 'auth', `refreshAccountTokens skipped for ${maskUpn(account.userPrincipalName)}: missing token fields`);
    return;
  }
  const minsUntilExpiry = Math.round((account.tokenExpiresAt - Date.now()) / 60_000);
  if (minsUntilExpiry > 10) {
    log('info', 'auth', `Token for ${maskUpn(account.userPrincipalName)} still valid (expires in ~${minsUntilExpiry} min), skipping refresh`);
    return;
  }

  log('info', 'auth', `Refreshing tokens for ${maskUpn(account.userPrincipalName)} (expires in ~${minsUntilExpiry} min)`);
  const clientId = getClientId(account.cloud);
  const scopes = getScopes(account.cloud);
  const db = await getDB();

  // Tier 1: refresh token grant
  try {
    const tokens = await refreshAccessToken({
      tokenEndpoint: account.tokenEndpoint,
      clientId,
      refreshToken: account.refreshToken,
      scopes,
    });
    // Re-read before writing so this stale snapshot cannot clobber concurrent
    // account writes (e.g. the tenantDisplayName backfill).
    const fresh = await db.get('accounts', account.id) ?? account;
    await db.put('accounts', {
      ...fresh,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      tokenExpiresAt: tokens.tokenExpiresAt,
      needsAttention: null,
    });
    notifyDbChanged('accounts');
    await refreshArmToken(account.id, db);
    return;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log('warn', 'auth', `Refresh token grant failed for ${maskUpn(account.userPrincipalName)}: ${error}`);
    if (error.includes('AADSTS65001')) {
      await markNeedsAttention(db, account, error);
      return;
    }
  }

  // Tier 2: silent SSO via launchWebAuthFlow
  try {
    const discovery = await discoverCloud(account.tenantId);
    const clientId2 = getClientId(discovery.cloud);
    const tokens = await runAuthCodeFlow({
      authorizationEndpoint: discovery.authorizationEndpoint,
      tokenEndpoint: discovery.tokenEndpoint,
      clientId: clientId2,
      scopes: getScopes(discovery.cloud),
      interactive: false,
      loginHint: account.userPrincipalName,
      prompt: 'none',
    });

    const fresh2 = await db.get('accounts', account.id) ?? account;
    await db.put('accounts', {
      ...fresh2,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? fresh2.refreshToken,
      idToken: tokens.idToken,
      tokenExpiresAt: tokens.tokenExpiresAt,
      loginHost: discovery.loginHost,
      graphHost: discovery.graphHost,
      tokenEndpoint: discovery.tokenEndpoint,
      needsAttention: null,
    });
    notifyDbChanged('accounts');
    await refreshArmToken(account.id, db);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log('warn', 'auth', `Silent SSO failed for ${maskUpn(account.userPrincipalName)}: ${error}`);
    await markNeedsAttention(db, account, error);
  }
}

/**
 * Runs a full interactive OAuth2 authorization code + PKCE sign-in flow for
 * `username`.
 *
 * 1. Derives the tenant from the username domain (or the explicit `tenantId`).
 * 2. Runs OpenID Connect discovery to resolve the correct cloud and endpoints.
 * 3. Launches the browser auth flow via `browser.identity.launchWebAuthFlow`.
 * 4. Exchanges the authorization code for tokens and verifies the ID token.
 *
 * Throws on state mismatch (CSRF guard), missing authorization code, or any
 * downstream auth/token error.
 * @param username - The user's email address; the domain is used to derive the tenant for discovery.
 * @param [tenantId] - Optional explicit tenant ID or domain, overrides the username domain.
 * @returns Resolved discovery metadata, token set, and verified ID token claims.
 * @throws On CSRF state mismatch, missing authorization code, or OAuth/token endpoint errors.
 */
export async function performSignIn(
  username: string,
  tenantId?: string
): Promise<{
  discovery: Awaited<ReturnType<typeof discoverCloud>>;
  tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  claims: Awaited<ReturnType<typeof verifyIdToken>>;
}> {
  const tenant = tenantId ?? username.split('@')[1];
  const discovery = await discoverCloud(tenant);
  const clientId = getClientId(discovery.cloud);

  const tokens = await runAuthCodeFlow({
    authorizationEndpoint: discovery.authorizationEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
    clientId,
    scopes: getScopes(discovery.cloud),
    interactive: true,
    loginHint: username,
  });

  const claims = await verifyIdToken(tokens.idToken, discovery, clientId);
  return { discovery, tokens, claims };
}

/**
 * Performs a full interactive PKCE authorization code flow for an existing
 * account. Used for explicit re-authentication (SIGN_IN_INTERACTIVE) and
 * step-up authentication when PIM policy requires MFA or an auth context claim.
 *
 * The authorization endpoint is reconstructed from `loginHost` and `tenantId`
 * (both stored on `AccountRecord`) to avoid an extra network round-trip.
 * Falls back to `discoverCloud` only when `loginHost` is null.
 *
 * Saves the refreshed token set to IndexedDB, clears `needsAttention`, and
 * fires `DB_CHANGED` for `accounts`. Returns the new access token.
 *
 * When `scopeOverride` is provided (e.g. ARM scopes), the token exchange uses
 * those scopes and the resulting token is stored as `armAccessToken` instead of
 * the default `accessToken`.
 * @param account - The account to re-authenticate.
 * @param claimsJson - Optional claims JSON forwarded to `buildAuthUrl` and the token endpoint.
 * @param scopeOverride - Optional scope array. When provided, overrides the default Graph scopes and stores the resulting token as `armAccessToken`.
 * @returns The new access token string.
 * @throws On state mismatch, missing authorization code, or token exchange failure.
 */
export async function acquireTokenInteractive(account: AccountRecord, claimsJson?: string, scopeOverride?: string[]): Promise<string> {
  let authorizationEndpoint: string;
  let tokenEndpoint: string;
  let cloud = account.cloud;

  if (account.loginHost && account.tokenEndpoint) {
    authorizationEndpoint = `${account.loginHost}/${account.tenantId}/oauth2/v2.0/authorize`;
    tokenEndpoint = account.tokenEndpoint;
  } else {
    const discovery = await discoverCloud(account.tenantId);
    authorizationEndpoint = discovery.authorizationEndpoint;
    tokenEndpoint = discovery.tokenEndpoint;
    cloud = discovery.cloud;
  }

  const clientId = getClientId(cloud);
  const isArmScope = !!scopeOverride;

  const tokens = await runAuthCodeFlow({
    authorizationEndpoint,
    tokenEndpoint,
    clientId,
    scopes: scopeOverride ?? getScopes(cloud),
    interactive: true,
    loginHint: account.userPrincipalName,
    claimsJson,
  });

  // When ARM scopes are used, store the token as armAccessToken. Otherwise update the
  // primary Graph token fields. Both paths clear needsAttention. The token endpoint is
  // not guaranteed to return a refresh_token (the ARM exchange omits offline_access and
  // relies on undocumented Entra behavior), so a missing one keeps the stored token
  // rather than clobbering it with undefined.
  const db = await getDB();
  const freshAccount = await db.get('accounts', account.id) ?? account;
  if (isArmScope) {
    await db.put('accounts', {
      ...freshAccount,
      armAccessToken: tokens.accessToken,
      armTokenExpiresAt: tokens.tokenExpiresAt,
      refreshToken: tokens.refreshToken ?? freshAccount.refreshToken,
      needsAttention: null,
    });
  } else {
    await db.put('accounts', {
      ...freshAccount,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? freshAccount.refreshToken,
      idToken: tokens.idToken,
      tokenExpiresAt: tokens.tokenExpiresAt,
      needsAttention: null,
    });
  }
  notifyDbChanged('accounts');
  return tokens.accessToken;
}

/**
 * Checks whether an access token satisfies the step-up requirements of a PIM policy
 * without making any network requests. Decodes the JWT payload and inspects the `amr`
 * and `acrs` claims. Returns true immediately when the policy has no step-up requirements.
 *
 * Always returns false if the token cannot be decoded, so the caller will proactively
 * re-authenticate rather than risk a rejected activation request.
 * @param token - Raw access token JWT string.
 * @param policy - The policy constraints to check against.
 */
export function tokenSatisfiesPolicy(
  token: string,
  policy: { mfaRequired: boolean; authContextRequired: boolean; authContextClassRef: string | null },
): boolean {
  try {
    const payload = decodeJwt(token);
    if (policy.mfaRequired) {
      const amr = payload.amr as string[] | undefined;
      if (!amr || !amr.includes('mfa')) return false;
    }
    if (policy.authContextRequired && policy.authContextClassRef) {
      const acrs = payload.acrs as string[] | undefined;
      if (!acrs || !acrs.includes(policy.authContextClassRef)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquires a step-up access token for the given account by launching an interactive
 * PKCE flow with the combined claims required by the policy. Handles MFA-only,
 * auth-context-only, and combined MFA+auth-context policies in one code path.
 *
 * Returns null when the policy has no step-up requirements (nothing to do).
 * Always interactive -- this is only called during explicit user-initiated activation,
 * so the user is present and Chrome will suppress the dialog if auth can be satisfied silently.
 * @param account - The account to re-authenticate.
 * @param resource - Whether to acquire a Graph token ('graph') or an ARM token ('arm').
 * @param policy - The policy constraints that the new token must satisfy.
 * @returns The new access token, or null if the policy requires no step-up.
 * @throws When `acquireTokenInteractive` fails (user cancels, or auth error).
 */
export async function acquireSteppedUpToken(
  account: AccountRecord,
  resource: 'graph' | 'arm',
  policy: { mfaRequired: boolean; authContextRequired: boolean; authContextClassRef: string | null },
): Promise<string | null> {
  const accessTokenClaims: Record<string, unknown> = {};
  if (policy.mfaRequired) {
    accessTokenClaims.amr = { essential: true, values: ['mfa'] };
  }
  if (policy.authContextRequired && policy.authContextClassRef) {
    accessTokenClaims.acrs = { essential: true, value: policy.authContextClassRef };
  }
  if (Object.keys(accessTokenClaims).length === 0) return null;

  const claimsJson = JSON.stringify({ access_token: accessTokenClaims });
  const scopeOverride = resource === 'arm' ? getArmScopes(account.cloud) : undefined;
  return acquireTokenInteractive(account, claimsJson, scopeOverride);
}
