import * as jose from 'jose';
import { GLOBALS } from '../constants.js';

/** Identifies which Microsoft cloud environment an account belongs to. */
export type CloudType = 'global' | 'gcc' | 'gcch' | 'dod';

/** Metadata resolved from OpenID Connect discovery for a specific tenant. */
export interface CloudDiscovery {
  cloud: CloudType;
  tenantId: string;
  issuer: string;
  jwksUri: string;
  loginHost: string;
  graphHost: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/** OAuth2 token response fields stored per account. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Epoch milliseconds derived from the access token's `exp` claim. */
  tokenExpiresAt: number;
}

/**
 * Decodes the `exp` claim from an access token JWT (without verifying the
 * signature) and converts it to epoch milliseconds.
 * @param accessToken - Raw JWT string from the token response.
 * @returns Epoch milliseconds when the token expires.
 */
export function accessTokenExpiresAt(accessToken: string): number {
  const { exp } = jose.decodeJwt(accessToken);
  return (exp as number) * 1000;
}

/** Claims extracted from a verified Microsoft Entra ID token. */
export interface IdTokenClaims {
  oid: string;
  tid: string;
  preferred_username: string;
  name?: string;
}

/**
 * Returns true if `email` matches a basic user@domain.tld pattern.
 * Used to validate the sign-in username before initiating an auth flow.
 * @param email - The string to validate.
 * @returns `true` if the string looks like a valid email address.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/**
 * Fetches the OpenID Connect discovery document for `tenant` from the global
 * Microsoft login endpoint and resolves all cloud-specific metadata.
 *
 * Detects the cloud type from the `cloud_instance_name`,
 * `tenant_region_scope`, and `tenant_region_sub_scope` fields:
 * - `microsoftonline.us` + DoD sub-scope -> `dod`
 * - `microsoftonline.us` + anything else -> `gcch`
 * - `NA` region + GCC sub-scope -> `gcc`
 * - everything else -> `global`
 *
 * Throws if the China cloud (`partner.microsoftonline.cn`) is detected, as it
 * is not supported.
 * @param tenant - Tenant domain (e.g. `contoso.com`) or tenant GUID.
 * @returns Fully resolved cloud metadata including endpoints and graph host.
 * @throws If the discovery request fails or a China cloud tenant is detected.
 */
export async function discoverCloud(tenant: string): Promise<CloudDiscovery> {
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/.well-known/openid-configuration`
  );
  if (!res.ok) {
    throw new Error(`Cloud discovery failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();

  const {
    cloud_instance_name,
    msgraph_host,
    tenant_region_scope,
    tenant_region_sub_scope,
    authorization_endpoint,
    token_endpoint,
    issuer,
    jwks_uri,
  } = json;

  if (cloud_instance_name === 'partner.microsoftonline.cn') {
    throw new Error('China cloud tenants are not supported');
  }

  let cloud: CloudType;
  if (cloud_instance_name === 'microsoftonline.us') {
    cloud = tenant_region_sub_scope === 'DoD' ? 'dod' : 'gcch';
  } else if (tenant_region_scope === 'NA' && tenant_region_sub_scope === 'GCC') {
    cloud = 'gcc';
  } else {
    cloud = 'global';
  }

  const tenantId = new URL(issuer).pathname.split('/')[1];
  const authUrl = new URL(authorization_endpoint);
  const loginHost = `${authUrl.protocol}//${authUrl.host}`;
  const graphHost = `https://${msgraph_host}`;

  return {
    cloud,
    tenantId,
    issuer,
    jwksUri: jwks_uri,
    loginHost,
    graphHost,
    authorizationEndpoint: authorization_endpoint,
    tokenEndpoint: token_endpoint,
  };
}

/**
 * Encodes a byte array as a base64url string (RFC 4648 §5) without padding.
 * Used internally for PKCE verifier and challenge generation.
 * @param bytes - Raw bytes to encode.
 * @returns Base64url-encoded string with no padding characters.
 */
function base64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generates a PKCE (RFC 7636) verifier/challenge pair.
 * - `verifier`: 32-byte cryptographically random base64url string sent with the token request.
 * - `challenge`: SHA-256 hash of the verifier, base64url-encoded, sent with the auth request.
 * @returns An object containing the `verifier` and `challenge` strings.
 */
export async function generatePKCEPair(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = base64urlEncode(array);
  const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64urlEncode(new Uint8Array(challengeBytes));
  return { verifier, challenge };
}

/**
 * Constructs an OAuth2 authorization URL with PKCE.
 *
 * If `claimsJson` is provided it is included as the `claims` query parameter.
 * @param params - Authorization request parameters including endpoint, client ID, scopes, PKCE challenge, and optional hints.
 * @returns The fully constructed authorization URL as a string.
 */
export function buildAuthUrl(params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
  loginHint?: string;
  claimsJson?: string;
  prompt?: string;
}): string {
  const { authorizationEndpoint, clientId, redirectUri, scopes, state, challenge, loginHint, claimsJson, prompt } = params;

  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (claimsJson) url.searchParams.set('claims', claimsJson);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  if (prompt) url.searchParams.set('prompt', prompt);

  return url.toString();
}

/**
 * Exchanges an authorization code for an access token, refresh token, and ID
 * token using the PKCE `authorization_code` grant.
 *
 * Throws if the token endpoint returns an error response.
 * @param params - Token exchange parameters including endpoint, client ID, authorization code, redirect URI, verifier, and scopes.
 * @returns A complete `TokenSet` with access, refresh, and ID tokens.
 * @throws If the token endpoint returns an OAuth error response.
 */
export async function exchangeCodeForTokens(params: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  redirectUri: string;
  verifier: string;
  scopes: string[];
  claimsJson?: string;
}): Promise<TokenSet> {
  const { tokenEndpoint, clientId, code, redirectUri, verifier, scopes, claimsJson } = params;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: clientId,
    scope: scopes.join(' '),
  });
  if (claimsJson) body.set('claims', claimsJson);

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = await res.json();
  if (json.error) {
    throw new Error(json.error_description ?? json.error);
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    tokenExpiresAt: accessTokenExpiresAt(json.access_token),
  };
}

/**
 * Obtains a new token set using the `refresh_token` grant.
 *
 * If the server does not return a new refresh token the existing one is
 * reused. Throws if the token endpoint returns an error response.
 * @param params - Refresh parameters including endpoint, client ID, refresh token, and scopes.
 * @returns A new `TokenSet`; the original refresh token is preserved if the server omits one.
 * @throws If the token endpoint returns an OAuth error response.
 */
export async function refreshAccessToken(params: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  scopes: string[];
  claimsJson?: string;
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    scope: params.scopes.join(' '),
  });
  if (params.claimsJson) body.set('claims', params.claimsJson);
  const res = await fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error_description ?? json.error);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? params.refreshToken,
    idToken: json.id_token,
    tokenExpiresAt: accessTokenExpiresAt(json.access_token),
  };
}

/**
 * Verifies an ID token's signature against the tenant's JWKS endpoint and
 * validates the `iss` and `aud` claims.
 *
 * Returns the typed claims subset needed by the rest of the application.
 * Throws if verification fails for any reason.
 * @param idToken - Raw ID token JWT string from the token response.
 * @param discovery - Cloud metadata used to locate the JWKS endpoint and expected issuer.
 * @param clientId - The registered application client ID, used to validate the `aud` claim.
 * @returns Verified claims including `oid`, `tid`, `preferred_username`, and optional `name`.
 * @throws If signature verification, issuer validation, or audience validation fails.
 */
export async function verifyIdToken(
  idToken: string,
  discovery: CloudDiscovery,
  clientId: string
): Promise<IdTokenClaims> {
  const JWKS = jose.createRemoteJWKSet(new URL(discovery.jwksUri));
  const { payload } = await jose.jwtVerify(idToken, JWKS, {
    issuer: discovery.issuer,
    audience: clientId,
  });
  return payload as unknown as IdTokenClaims;
}

/**
 * Returns the registered Entra ID application (client) ID for the given cloud.
 * Global and GCC share one app registration; GCCH and DoD share another.
 *
 * Throws if the relevant client ID is not configured in `GLOBALS`.
 * @param cloud - The cloud environment to look up.
 * @returns The client ID string for that cloud's app registration.
 * @throws If no client ID is configured for the given cloud type.
 */
export function getClientId(cloud: CloudType): string {
  const id = cloud === 'global' || cloud === 'gcc'
    ? GLOBALS.CLIENT_ID.GLOBAL
    : GLOBALS.CLIENT_ID.GOVERNMENT;
  if (!id) throw new Error('No client ID configured for this cloud');
  return id;
}

/**
 * Returns the OAuth2 scopes to request for the given cloud type.
 *
 * GCCH and DoD require fully-qualified scope URIs with their sovereign Graph
 * host prefix; global and GCC use unqualified scope names because the token
 * endpoint infers the resource from the scope string.
 * @param cloud - The cloud environment to get scopes for.
 * @returns Array of OAuth2 scope strings ready to pass to the authorization endpoint.
 */
export function getScopes(cloud: CloudType): string[] {
  const base = ['openid', 'profile', 'offline_access'];
  const graphScopes = [
    'User.Read',
    'Organization.Read.All',
    'RoleManagement.ReadWrite.Directory',
    'RoleManagementPolicy.Read.Directory',
    // Required by the beta roleAssignmentApprovals endpoint despite being at a v3-style URL path.
    // The docs claim RoleAssignmentSchedule.* suffices but the API runtime enforces this scope.
    'PrivilegedAccess.ReadWrite.AzureAD',
    'PrivilegedEligibilitySchedule.Read.AzureADGroup',
    'PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup',
    'RoleManagementPolicy.Read.AzureADGroup',
  ];
  if (cloud === 'gcch') {
    return [...base, ...graphScopes.map(s => `https://graph.microsoft.us/${s}`)];
  }
  if (cloud === 'dod') {
    return [...base, ...graphScopes.map(s => `https://dod-graph.microsoft.us/${s}`)];
  }
  return [...base, ...graphScopes];
}

/**
 * Returns the Azure Resource Manager (ARM) base URL for the given cloud.
 * @param cloud - The cloud environment.
 * @returns ARM base URL string.
 */
export function getArmHost(cloud: CloudType): string {
  return (cloud === 'gcch' || cloud === 'dod')
    ? 'https://management.usgovcloudapi.net'
    : 'https://management.azure.com';
}

/**
 * Returns the OAuth2 scope to request for the Azure Management API.
 * ARM only requires `user_impersonation` — no OIDC base scopes are included.
 * @param cloud - The cloud environment.
 * @returns Array containing the single ARM scope string.
 */
export function getArmScopes(cloud: CloudType): string[] {
  return [`${getArmHost(cloud)}/user_impersonation`];
}

/**
 * Obtains an ARM-scoped access token using the refresh_token grant.
 *
 * Entra ID returns a refresh_token in the ARM response even without
 * `offline_access` in the scope; it is discarded here because the caller's
 * existing refresh token is audience-agnostic and already serves this purpose.
 * @param params - Token parameters including endpoint, client ID, refresh token, and cloud.
 * @returns The ARM access token and its expiry in epoch milliseconds.
 * @throws If the token endpoint returns an OAuth error response.
 */
export async function fetchArmAccessToken(params: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  cloud: CloudType;
}): Promise<{ accessToken: string; tokenExpiresAt: number }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    scope: getArmScopes(params.cloud).join(' '),
  });
  const res = await fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error_description ?? json.error);
  return {
    accessToken: json.access_token,
    tokenExpiresAt: accessTokenExpiresAt(json.access_token),
  };
}
