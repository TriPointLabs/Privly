/**
 * Tab refresh helpers invoked after successful PIM activations.
 *
 * After an Entra role or group activation, open admin portal tabs have their
 * cookies and local storage cleared so the portal re-authenticates and
 * re-fetches fresh role/group data on reload. After an Azure ARM activation,
 * open Azure portal tabs are reloaded without clearing storage.
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
 * Chrome scopes a `browsingData.remove` call with an `origins` array; Firefox
 * uses `hostnames` instead and ignores `origins` entirely, which would widen the
 * removal to every site in the browser. `@types/webextension-polyfill` models
 * only the Firefox shape, so the Chrome-only contract is declared here and the
 * single narrowing cast is confined to `resolveOriginScopedBrowsingData`.
 *
 * `localStorage` is the only data type Chrome scopes to the exact origin --
 * cookies are cleared for the whole registrable domain, so they are handled
 * through the `cookies` API instead (see `clearCookiesForUrl`).
 */
interface OriginScopedBrowsingData {
  remove(
    options: { origins: string[] },
    dataToRemove: { localStorage?: boolean },
  ): Promise<void>;
}

/**
 * Returns the `browsingData` API only when it is present and exposes `remove`.
 * Returns null otherwise so callers degrade to a plain reload instead of
 * throwing on a build whose manifest omits the permission.
 */
function resolveOriginScopedBrowsingData(): OriginScopedBrowsingData | null {
  const api = (browser as { browsingData?: unknown }).browsingData;
  if (!api || typeof (api as OriginScopedBrowsingData).remove !== 'function') return null;
  return api as OriginScopedBrowsingData;
}

/**
 * Removes every cookie that would be sent to `url`, one cookie at a time.
 *
 * `browsingData.remove({ origins }, { cookies: true })` is deliberately not used
 * here: Chrome clears cookies for the whole registrable domain, so refreshing a
 * single `contoso.sharepoint.com` tab would sign the user out of every other
 * SharePoint tenant and OneDrive, and refreshing `admin.microsoft.com` would
 * clear cookies across all of `microsoft.com`. `cookies.getAll({ url })` returns
 * the strict subset that this page's session actually uses, which preserves the
 * intended effect without the collateral.
 *
 * Each removal is addressed by the cookie's own domain and path, so a cookie on
 * a parent domain outside our host permissions is skipped rather than failing
 * the batch. Counts are logged so the outcome is observable in the Debug panel.
 * @param url - The tab origin whose cookie jar should be cleared.
 */
async function clearCookiesForUrl(url: string): Promise<void> {
  const cookies = await browser.cookies.getAll({ url });
  if (cookies.length === 0) return;

  const results = await Promise.all(cookies.map(async cookie => {
    // Address the cookie by its own domain/path; a leading dot marks a domain
    // cookie and resolves to the bare host.
    const host = cookie.domain.replace(/^\./, '');
    const cookieUrl = `http${cookie.secure ? 's' : ''}://${host}${cookie.path}`;
    try {
      await browser.cookies.remove({ url: cookieUrl, name: cookie.name, storeId: cookie.storeId });
      return true;
    } catch {
      // Almost always a cookie on a parent domain we hold no host permission
      // for. Skipping it is the correct outcome -- it is shared with sites
      // outside this extension's scope.
      return false;
    }
  }));

  const cleared = results.filter(Boolean).length;
  log('info', 'general', `Cleared ${cleared}/${cookies.length} cookie(s) for ${new URL(url).host}`);
}

/**
 * Called after a successful Entra role or group activation.
 *
 * Finds all open admin portal tabs, clears each origin's cookies and local
 * storage so the portal re-fetches role data, then reloads every tab.
 *
 * Session storage is deliberately not addressed: it survives a reload and is
 * discarded only when the tab closes, and no extension API can clear it for a
 * page. A portal that caches role state there will not reflect the change until
 * the tab is closed and reopened.
 */
export async function refreshAdminPortalTabs(): Promise<void> {
  const tabs = await browser.tabs.query({ url: ADMIN_PORTAL_PATTERNS });
  log('info', 'general', `refreshAdminPortalTabs: ${tabs.length} matching tab(s)`);

  if (tabs.length === 0) return;

  // Deduplicate by origin: getAll({ url }) ignores the path, so two tabs on the
  // same origin would otherwise walk the same cookie jar twice.
  const origins = [...new Set(
    tabs.map(t => { try { return new URL(t.url ?? '').origin; } catch { return null; } })
        .filter((o): o is string => o !== null)
  )];

  if (browser.cookies) {
    await Promise.all(origins.map(origin => clearCookiesForUrl(origin).catch(e => {
      log('warn', 'general', `Cookie clear failed for ${origin}: ${e instanceof Error ? e.message : String(e)}`);
    })));
  } else {
    log('warn', 'general', 'Cookie clearing skipped: cookies API unavailable in this build');
  }

  const browsingData = resolveOriginScopedBrowsingData();
  if (browsingData) {
    await browsingData.remove({ origins }, { localStorage: true });
  } else {
    log('warn', 'general', 'Local storage clearing skipped: browsingData API unavailable in this build');
  }

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
