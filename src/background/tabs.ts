/**
 * Tab refresh helpers invoked after successful PIM activations.
 *
 * After an Entra role or group activation, open admin portal tabs have their
 * local storage and cookies cleared so the portal re-fetches fresh role/group
 * data on reload. After an Azure ARM activation, open Azure
 * portal tabs are reloaded without clearing storage.
 */
import browser from 'webextension-polyfill';
import { log } from './log.ts';

// Admin portal URL patterns -- excludes API endpoints (graph, login, management).
const ADMIN_PORTAL_PATTERNS = [
  'https://entra.microsoft.com/*',
  'https://entra.microsoft.us/*',
  'https://security.microsoft.com/*',
  'https://security.microsoft.us/*',
  'https://compliance.microsoft.com/*',
  'https://compliance.microsoft.us/*',
  'https://purview.microsoft.com/*',
  'https://purview.microsoft.us/*',
  'https://admin.microsoft.com/*',
  'https://portal.office365.us/*',
  'https://admin.exchange.microsoft.com/*',
  'https://admin.teams.microsoft.com/*',
  'https://*.admin.cloud.microsoft/*',
  'https://*.sharepoint.com/*',
  'https://*.sharepoint.us/*',
  'https://intune.microsoft.com/*',
  'https://intune.microsoft.us/*',
];

const AZURE_PORTAL_PATTERNS = [
  'https://portal.azure.com/*',
  'https://portal.azure.us/*',
];

/**
 * Called after a successful Entra role or group activation.
 *
 * Finds all open tabs matching admin portal hostnames, clears their local
 * storage and cookies (so the portal re-fetches role data), then reloads
 * each tab. Session storage is tab-scoped and cleared automatically on reload.
 */
export async function refreshAdminPortalTabs(): Promise<void> {
  const tabs = await browser.tabs.query({ url: ADMIN_PORTAL_PATTERNS });
  log('info', 'general', `refreshAdminPortalTabs: ${tabs.length} matching tab(s)`);

  if (tabs.length === 0) return;

  // Collect unique origins so we issue one browsingData.remove call per origin.
  const origins = [...new Set(
    tabs
      .map(t => { try { return new URL(t.url ?? '').origin; } catch { return null; } })
      .filter((o): o is string => o !== null)
  )];

  await (browser.browsingData as any).remove(
    { origins },
    { localStorage: true, cookies: true },
  );

  await Promise.all(
    tabs
      .filter(t => t.id !== undefined)
      .map(t => browser.tabs.reload(t.id!))
  );
}

/**
 * Called after a successful Azure ARM role activation.
 *
 * Finds all open Azure portal tabs and reloads them. No storage clearing
 * is needed -- the portal picks up the new role from ARM on the next page load.
 */
export async function refreshAzurePortalTabs(): Promise<void> {
  const tabs = await browser.tabs.query({ url: AZURE_PORTAL_PATTERNS });
  log('info', 'general', `refreshAzurePortalTabs: ${tabs.length} matching tab(s)`);

  await Promise.all(
    tabs
      .filter(t => t.id !== undefined)
      .map(t => browser.tabs.reload(t.id!))
  );
}
