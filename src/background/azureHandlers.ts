/**
 * Handlers for Azure ARM PIM commands (ACTIVATE_AZURE_ROLE and
 * DEACTIVATE_AZURE_ROLE). Step-up and error dispatch is delegated to the
 * shared engine in `activation.ts`; this module owns the ARM request shapes
 * and post-activation Azure re-sync.
 */
import { getDB, getExtensionSettings, type ActivatingRecord } from '../tools/db.ts';
import { notify } from '../tools/notify.ts';
import { getArmHost } from '../tools/oauth.ts';
import type { CommandAck, CommandMessage } from '../types/messages.ts';
import { executeActivationRequest, confirmActivationVisible } from './activation.ts';
import { syncAzureEligibleAssignments, syncAzureActiveAssignments, refreshSingleAzurePolicy } from './sync.ts';
import {
  notifyDbChanged,
  parseGraphError,
  pollUntilProvisioned,
  fetchWithRetry,
  PENDING_ACTIVATION_STATUSES,
} from './utils.ts';
import { refreshAzurePortalTabs } from './tabs.ts';
import { saveJustificationPrefill } from './prefills.ts';
import { log, maskUpn } from './log.ts';
import { checkExpiries } from './expiry.ts';
import { updateBadge } from './badge.ts';

type ActivateAzurePayload = Extract<CommandMessage, { type: 'ACTIVATE_AZURE_ROLE' }>['payload'];
type DeactivateAzurePayload = Extract<CommandMessage, { type: 'DEACTIVATE_AZURE_ROLE' }>['payload'];

/**
 * Initiates an ARM PIM SelfActivate request, writes an `activating` record
 * while polling for provisioning, then re-syncs the Azure stores.
 */
export async function handleActivateAzureRole(payload: ActivateAzurePayload): Promise<CommandAck> {
  const { accountId, azureRoleId, durationMinutes, justification, ticketNumber, ticketSystem, savePrefill } = payload;

  const db = await getDB();
  const [account, roleRecord] = await Promise.all([
    db.get('accounts', accountId),
    db.get('azure_roles', azureRoleId),
  ]);
  if (!account) return { ok: false, error: 'Account not found' };
  if (!account.armAccessToken) return { ok: false, error: 'No ARM token -- try refreshing' };
  if (!roleRecord) return { ok: false, error: 'Azure role record not found' };

  const armHost = getArmHost(account.cloud);
  // ARM schedule requests are PUT to a client-generated GUID, which makes the
  // request idempotent: a retried PUT with the same GUID cannot double-activate.
  const requestGuid = crypto.randomUUID();
  const displayName = roleRecord.roleDisplayName;

  const url =
    `${armHost}${roleRecord.scopeId}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/${requestGuid}` +
    `?api-version=2020-10-01`;

  const properties: Record<string, unknown> = {
    requestType: 'SelfActivate',
    principalId: roleRecord.principalId,
    roleDefinitionId: roleRecord.roleDefinitionId,
    justification: justification ?? '',
    scheduleInfo: {
      startDateTime: new Date().toISOString(),
      expiration: { type: 'AfterDuration', duration: `PT${durationMinutes}M` },
    },
  };
  if (ticketNumber) {
    properties.ticketInfo = { ticketNumber, ticketSystem: ticketSystem ?? '' };
  }

  log('info', 'activate', `ACTIVATE_AZURE_ROLE: PUT ${url}`);
  const makePut = (token: string) => fetchWithRetry(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties }),
  });

  const azurePolicyKey = `${roleRecord.scopeId}::${roleRecord.roleDefinitionId}`;
  const cachedAzurePolicy = await db.get('azure_policies', azurePolicyKey);
  const result = await executeActivationRequest({
    account,
    resource: 'arm',
    initialToken: account.armAccessToken,
    makeRequest: makePut,
    isSuccess: r => r.ok,
    cachedPolicy: cachedAzurePolicy,
    onPolicyStale: () => refreshSingleAzurePolicy(account, roleRecord.scopeId, roleRecord.roleDefinitionId),
    logLabel: 'ACTIVATE_AZURE_ROLE',
    failLabel: 'Azure activation',
    notifyLabel: 'Azure activation failed',
  });
  if (!result.ok) return { ok: false, error: result.error };
  const res = result.res;
  const armToken = result.token;

  // If step-up elevated the ARM token, persist it so the next activation in the same session
  // doesn't need to step up again.
  if (armToken !== account.armAccessToken) {
    const stepUpDb = await getDB();
    const current = await stepUpDb.get('accounts', accountId);
    if (current) await stepUpDb.put('accounts', { ...current, armAccessToken: armToken });
  }

  // ARM nests status under properties (Graph returns it at the top level).
  const resBody = await res.json() as { properties?: { status?: string } };
  let finalStatus = resBody.properties?.status ?? 'Unknown';

  // Write an activating record so the popup shows a spinner on the eligible card while polling.
  if (!finalStatus || PENDING_ACTIVATION_STATUSES.has(finalStatus)) {
    const activatingDb = await getDB();
    await activatingDb.put('activating', {
      id: requestGuid,
      accountId,
      kind: 'azure_role',
      recordId: azureRoleId,
      displayName,
      startedAt: Date.now(),
    } satisfies ActivatingRecord);
    notifyDbChanged('activating');

    // Poll for provisioning completion. An inconclusive poll keeps the PUT's status.
    const pollUrl =
      `${armHost}${roleRecord.scopeId}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/${requestGuid}` +
      `?api-version=2020-10-01`;
    const polled = await pollUntilProvisioned(pollUrl, armToken, 3000, 8,
      body => (body as { properties?: { status?: string } }).properties?.status);
    if (polled !== 'Unknown') finalStatus = polled;

    const cleanDb = await getDB();
    await cleanDb.delete('activating', requestGuid);
    notifyDbChanged('activating');
  }

  log('info', 'activate', `ACTIVATE_AZURE_ROLE succeeded for ${maskUpn(account.userPrincipalName)}, "${displayName}": ${finalStatus}`);

  // The request was accepted, so the justification is worth keeping.
  if (savePrefill) await saveJustificationPrefill(accountId, justification);
  if (finalStatus === 'PendingApproval') {
    await notify('Activation request submitted', `"${displayName}" is awaiting approval`);
  } else {
    await notify('Azure role activated', `${displayName} activated`, 'ping');
    const settings = await getExtensionSettings();
    if (settings.reloadPortalsOnActivation) {
      setTimeout(() => refreshAzurePortalTabs().catch(() => {}), 1500);
    }
  }

  const freshDb = await getDB();
  const freshAccount = await freshDb.get('accounts', accountId) ?? account;
  await Promise.all([
    syncAzureEligibleAssignments(freshAccount),
    syncAzureActiveAssignments(freshAccount),
  ]);
  // Azure activations feed the badge countdown alongside the Entra ones, so the
  // badge has to be repainted here too, as the Entra paths already do.
  await updateBadge();
  void checkExpiries().catch(() => {});

  // ARM may not list the new assignment yet, so keep checking in the
  // background. Scoped by scopeId as well as role definition, since the same
  // role can be held at more than one scope. Skipped for approval-pending
  // requests, where no activation is expected until an approver acts.
  if (finalStatus !== 'PendingApproval') {
    void confirmActivationVisible(freshAccount, {
      kind: 'azure',
      scopeId: roleRecord.scopeId,
      roleDefinitionId: roleRecord.roleDefinitionId,
    }).catch(() => {});
  }
  return { ok: true };
}

/** Cancels an active ARM PIM assignment via a SelfDeactivate request, then re-syncs the Azure stores. */
export async function handleDeactivateAzureRole(payload: DeactivateAzurePayload): Promise<CommandAck> {
  const { accountId, azureActivationId } = payload;

  const db = await getDB();
  const [account, activationRecord] = await Promise.all([
    db.get('accounts', accountId),
    db.get('azure_activations', azureActivationId),
  ]);
  if (!account) return { ok: false, error: 'Account not found' };
  if (!account.armAccessToken) return { ok: false, error: 'No ARM token -- try refreshing' };
  if (!activationRecord) return { ok: false, error: 'Azure activation record not found' };

  const armHost = getArmHost(account.cloud);
  const requestGuid = crypto.randomUUID();
  const displayName = activationRecord.roleDisplayName;

  const url =
    `${armHost}${activationRecord.scopeId}/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/${requestGuid}` +
    `?api-version=2020-10-01`;

  const properties: Record<string, unknown> = {
    requestType: 'SelfDeactivate',
    principalId: activationRecord.principalId,
    roleDefinitionId: activationRecord.roleDefinitionId,
  };

  log('info', 'activate', `DEACTIVATE_AZURE_ROLE: PUT ${url} (role: ${displayName})`);
  const res = await fetchWithRetry(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${account.armAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '(unreadable)');
    log('error', 'activate', `DEACTIVATE_AZURE_ROLE failed: HTTP ${res.status} ${bodyText}`);
    const errorMsg = parseGraphError(bodyText, `Azure deactivation failed (HTTP ${res.status})`);
    await notify('Azure deactivation failed', errorMsg);
    return { ok: false, error: errorMsg };
  }

  log('info', 'activate', `DEACTIVATE_AZURE_ROLE succeeded for ${maskUpn(account.userPrincipalName)}, "${displayName}"`);
  await notify('Azure role deactivated', `${displayName} deactivated`, 'ping');

  const freshDb = await getDB();
  const freshAccount = await freshDb.get('accounts', accountId) ?? account;
  await Promise.all([
    syncAzureEligibleAssignments(freshAccount),
    syncAzureActiveAssignments(freshAccount),
  ]);
  // Matches the Entra deactivation path: the countdown may have just lost the
  // activation it was showing.
  await updateBadge();
  void checkExpiries().catch(() => {});
  return { ok: true };
}
