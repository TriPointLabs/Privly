import browser from 'webextension-polyfill';
import { getExtensionSettings } from './db.js';
import { sendNotification } from '../types/messages.js';

/**
 * Shows a browser notification if the user has notifications enabled.
 * No-ops silently when notifications are disabled in extension settings.
 *
 * If `sound` is provided, also sends a `PLAY_SOUND` message to the popup
 * (fire-and-forget). The popup plays the audio if it is open; if it is
 * closed the OS notification alone provides feedback.
 *
 * @param title - The notification title.
 * @param message - The notification body text.
 * @param sound - Optional sound to play: 'ping' (activation/deactivation),
 *   'expiring' (role expiring soon), or 'expired' (role expired).
 */
export async function notify(title: string, message: string, sound?: 'ping' | 'expiring' | 'expired'): Promise<void> {
  const settings = await getExtensionSettings();
  if (!settings.showNotifications) return;
  await browser.notifications.create({
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/48.png'),
    title,
    message
  });
  if (sound) {
    sendNotification({ type: 'PLAY_SOUND', sound });
  }
}
