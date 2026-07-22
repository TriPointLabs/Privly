import browser from 'webextension-polyfill';

/** User-selected theme setting; 'system' follows the OS color scheme. */
export type ThemePreference = 'dark' | 'light' | 'system';
/** Concrete theme applied to the DOM after resolving 'system'. */
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'theme';

function getMediaQuery(): MediaQueryList | null {
  return typeof window !== 'undefined'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}

/** Resolves a theme preference to an actual dark/light value. 'system' uses the OS setting, falling back to dark. */
export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === 'system') {
    const mq = getMediaQuery();
    return mq?.matches !== false ? 'dark' : 'light';
  }
  return pref;
}

/** Applies the resolved theme to the DOM by swapping the class on <html>. */
export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.remove('dark', 'light');
  document.documentElement.classList.add(resolved);
}

/** Caches the theme preference in storage.local for flash-free startup. */
export function cacheThemePreference(pref: ThemePreference): void {
  browser.storage.local.set({ [STORAGE_KEY]: pref }).catch(() => {});
}

/** Reads the cached theme preference from storage.local. Returns null if none is cached. */
export async function getCachedThemePreference(): Promise<ThemePreference | null> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const val = result[STORAGE_KEY];
  if (val === 'dark' || val === 'light' || val === 'system') return val;
  return null;
}

/**
 * Starts watching for OS color scheme changes. When the OS preference changes
 * and the current setting is 'system', calls the provided callback so the
 * caller can re-apply the resolved theme.
 *
 * Returns a cleanup function to remove the listener.
 */
export function watchSystemTheme(getCurrentPref: () => ThemePreference, onChange: (resolved: ResolvedTheme) => void): () => void {
  const mq = getMediaQuery();
  if (!mq) return () => {};

  const handler = () => {
    if (getCurrentPref() === 'system') {
      onChange(resolveTheme('system'));
    }
  };

  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
