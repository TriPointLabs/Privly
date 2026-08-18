import browser from 'webextension-polyfill';
import { getExtensionSettings } from './db.js';
import { sendNotification } from '../types/messages.js';
import { log } from '../background/log.ts';

/**
 * Shows a browser notification if the user has notifications enabled.
 * No-ops silently when notifications are disabled in extension settings.
 *
 * If `sound` is provided, also sends a `PLAY_SOUND` message to the popup
 * (fire-and-forget). The popup plays the audio if it is open; if it is
 * closed the OS notification alone provides feedback.
 *
 * A notification is a courtesy, never a reason to fail the operation that
 * triggered it, so a rejection from `notifications.create` is logged and
 * swallowed. Chrome rejects with "Unable to download all specified images"
 * when it cannot load the icon; because most callers await this on the success
 * path of an activation, an unhandled rejection there aborted the remaining
 * post-activation work (targeted resync, badge refresh, portal reload) and
 * reported failure for a role that had in fact activated.
 *
 * @param title - The notification title.
 * @param message - The notification body text.
 * @param sound - Optional sound to play: 'ping' (activation/deactivation),
 *   'expiring' (role expiring soon), or 'expired' (role expired).
 */
export async function notify(title: string, message: string, sound?: 'ping' | 'expiring' | 'expired'): Promise<void> {
  const settings = await getExtensionSettings();
  if (!settings.showNotifications) return;
  try {
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/48.png'),
      title,
      message
    });
  } catch (e) {
    log('warn', 'general', `Notification could not be shown: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (sound) {
    sendNotification({ type: 'PLAY_SOUND', sound });
  }
}
