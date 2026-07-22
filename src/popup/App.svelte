<script lang="ts">
  /**
   * Root component. Manages top-level view routing between loading, login,
   * main, and settings pages with horizontal slide transitions.
   *
   * The DB_CHANGED message listener is registered synchronously (before any
   * await) so that notifications fired during the initial IndexedDB read are
   * never missed.
   */
  import { tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import browser from 'webextension-polyfill';
  import { quintOut, cubicIn } from 'svelte/easing';
  import { Alert } from './components/ui/index.js';

  /**
   * Custom Svelte transition that slides a node along the X axis.
   * `x` may be a pixel number or a CSS length string (e.g. "100%").
   * @param node - The DOM element being transitioned.
   * @param options - Transition options: `x` offset, `duration` in ms, and `easing` function.
   * @returns A Svelte `TransitionConfig` object with a CSS animation factory.
   */
  function slideX(node: Element, { x, duration, easing }: { x: number | string; duration: number; easing: (t: number) => number }) {
    const val = typeof x === 'string' ? x : `${x}px`;
    return { duration, easing, css: (t: number) => `transform: translateX(calc(${(1 - t)} * ${val}))` };
  }
  import LoginPage from './LoginPage.svelte';
  import MainPage from './MainPage.svelte';
  import SettingsPage from './SettingsPage.svelte';
  import DebugPage from './DebugPage.svelte';
  import { getAccounts, getStates, getExtensionSettings, type StateRecord } from '../tools/db.js';
  import { Spinner } from './components/ui/index.js';
  import { applyTheme, resolveTheme, watchSystemTheme, type ThemePreference } from './theme.js';
  import { installPopupErrorLogging } from './log.js';

  installPopupErrorLogging();

  type View = 'loading' | 'login' | 'main' | 'settings' | 'debug';
  type LoginMode = 'initial' | 'add-account';
  type NavDirection = 'forward' | 'back' | null;

  browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'PLAY_SOUND') {
      const soundMap: Record<'ping' | 'expiring' | 'expired', string> = {
        ping: 'sounds/notification-ping.mp3',
        expiring: 'sounds/expiring.mp3',
        expired: 'sounds/expired.mp3',
      };
      const file = soundMap[message.sound as 'ping' | 'expiring' | 'expired'];
      if (file) new Audio(browser.runtime.getURL(file)).play().catch(() => {});
      return;
    }
    if (message.type !== 'DB_CHANGED') return;
    const stores = (message.stores as string[]);
    if (stores.includes('accounts')) {
      navDirection = null;
      getAccounts().then(accs => {
        const target: View = accs.length > 0 ? 'main' : 'login';
        // Never yank the user out of the debug subview; retarget its back destination instead.
        if (view === 'debug') {
          debugReturnTo = target;
        } else {
          view = target;
        }
      });
    }
    if (stores.includes('states')) {
      getStates().then(s => { states = s; });
    }
    if (stores.includes('extension_settings')) {
      getExtensionSettings().then(s => {
        currentThemePref = s.theme;
        applyTheme(resolveTheme(s.theme));
      });
    }
  });

  let view = $state<View>('loading');
  let loginMode = $state<LoginMode>('initial');
  let navDirection = $state<NavDirection>(null);
  let states = $state<StateRecord[]>([]);
  let currentThemePref = $state<ThemePreference>('system');
  /** View to return to when the debug subview closes (it can be opened from anywhere). */
  let debugReturnTo = $state<View>('main');

  let signInPending = $derived(states.some(s => s.id === 'sign-in:new' && s.status === 'pending'));
  let signInError = $derived(
    states.find(s => s.id === 'sign-in:new' && s.status === 'error')?.error ?? null
  );

  /** Animates back from the login (add-account) or settings page to main. */
  async function handleBack() {
    navDirection = 'back';
    loginMode = 'initial';
    await tick();
    view = 'main';
  }

  /** Navigates forward to the login page in add-account mode. */
  async function handleAddAccount() {
    navDirection = 'forward';
    loginMode = 'add-account';
    await tick();
    view = 'login';
  }

  /** Navigates forward to the settings page. */
  async function handleOpenSettings() {
    navDirection = 'forward';
    await tick();
    view = 'settings';
  }

  /** Animates back from the settings page to main. */
  async function handleSettingsBack() {
    navDirection = 'back';
    await tick();
    view = 'main';
  }

  /** Opens the debug subview from any view, remembering where to return. */
  async function handleOpenDebug() {
    debugReturnTo = view;
    navDirection = 'forward';
    await tick();
    view = 'debug';
  }

  /** Returns from the debug subview to wherever it was opened from. */
  async function handleDebugBack() {
    navDirection = 'back';
    await tick();
    view = debugReturnTo;
  }

  /**
   * Loads initial state from IndexedDB and sets the starting view.
   * Called once on mount; the message listener handles subsequent updates.
   */
  async function init() {
    const [accounts, initialStates, settings] = await Promise.all([
      getAccounts(),
      getStates(),
      getExtensionSettings(),
    ]);
    states = initialStates;
    currentThemePref = settings.theme;
    applyTheme(resolveTheme(settings.theme));
    view = accounts.length > 0 ? 'main' : 'login';
  }

  init();

  // Watch for OS-level color scheme changes when the user has selected 'system'.
  watchSystemTheme(() => currentThemePref, applyTheme);

  type AlertItem = { id: string; type: 'success' | 'error' | 'info'; message: string };
  let alerts = $state<AlertItem[]>([]);

  function addAlert(type: AlertItem['type'], message: string) {
    const id = crypto.randomUUID();
    alerts.push({ id, type, message });
    setTimeout(() => { alerts = alerts.filter(a => a.id !== id); }, 4000);
  }

  function removeAlert(id: string) {
    alerts = alerts.filter(a => a.id !== id);
  }
</script>

<div class="w-full h-full bg-surface-900 overflow-hidden relative">
  {#if view === 'loading'}
    <div class="flex items-center justify-center h-full">
      <div role="status" aria-label="Loading"><Spinner /></div>
    </div>
  {:else if view === 'login'}
    <div
      class="absolute inset-0 z-[60]"
      in:slideX={{ x: navDirection === 'forward' ? '100%' : 0, duration: navDirection === 'forward' ? 300 : 0, easing: quintOut }}
      out:slideX={{ x: navDirection === 'back' ? '100%' : 0, duration: navDirection === 'back' ? 260 : 0, easing: cubicIn }}
    >
      <LoginPage
        mode={loginMode}
        {signInPending}
        {signInError}
        onBack={handleBack}
        onOpenDebug={handleOpenDebug}
      />
    </div>
  {:else if view === 'main'}
    <div
      class="absolute inset-0"
      in:slideX={{ x: navDirection === 'back' ? -80 : 0, duration: navDirection === 'back' ? 300 : 0, easing: quintOut }}
      out:slideX={{ x: navDirection === 'forward' ? -80 : 0, duration: navDirection === 'forward' ? 300 : 0, easing: quintOut }}
    >
      <MainPage onAddAccount={handleAddAccount} onOpenSettings={handleOpenSettings} {addAlert} />
    </div>
  {:else if view === 'debug'}
    <div
      class="absolute inset-0 z-[70]"
      in:slideX={{ x: '100%', duration: 300, easing: quintOut }}
      out:slideX={{ x: '100%', duration: 260, easing: cubicIn }}
    >
      <DebugPage onBack={handleDebugBack} />
    </div>
  {:else if view === 'settings'}
    <div
      class="absolute inset-0 z-[60]"
      in:slideX={{ x: navDirection === 'forward' ? '100%' : 0, duration: navDirection === 'forward' ? 300 : 0, easing: quintOut }}
      out:slideX={{ x: navDirection === 'back' ? '100%' : 0, duration: navDirection === 'back' ? 260 : 0, easing: cubicIn }}
    >
      <SettingsPage onBack={handleSettingsBack} onOpenDebug={handleOpenDebug} />
    </div>
  {/if}

  <!-- Alert overlay sits outside all transitioned wrappers and uses absolute (not fixed)
       positioning so it is always in the root div's stacking context. fixed would escape
       to the viewport but can be re-trapped if any ancestor gains a transform at runtime. -->
  <div
    class="pointer-events-none absolute inset-x-0 top-12 z-[200] flex flex-col gap-2 px-3 pt-2"
  >
    {#each alerts as alert (alert.id)}
      <div class="pointer-events-auto" transition:slide={{ duration: 150 }}>
        <Alert type={alert.type} message={alert.message} onDismiss={() => removeAlert(alert.id)} />
      </div>
    {/each}
  </div>
</div>
