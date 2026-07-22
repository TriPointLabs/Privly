/**
 * Popup-side logging shim. The popup never writes IndexedDB, so diagnostic
 * entries are routed to the service worker via the LOG_EVENT command and land
 * in the `logs` store under the 'popup' category.
 *
 * Do not include UPNs, tokens, or other identifiers in messages -- the popup
 * has no redaction helpers and the service worker records the text as-is.
 */
import { sendCommand, MessageType } from '../types/messages.js';

/** Records a popup diagnostic entry. Fire-and-forget; failures are swallowed. */
export function popupLog(level: 'info' | 'warn' | 'error', message: string): void {
  sendCommand(MessageType.LOG_EVENT, { level, message }).catch(() => {});
}

/**
 * Installs window-level catch-alls so unhandled popup errors and promise
 * rejections are recorded instead of vanishing. Call once at popup startup.
 */
export function installPopupErrorLogging(): void {
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
    popupLog('error', `Unhandled rejection: ${reason}`);
  });
  window.addEventListener('error', (e) => {
    popupLog('error', `Uncaught error: ${e.message}`);
  });
}
