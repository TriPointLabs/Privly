<script lang="ts">
  /**
   * Sign-in page shown on first launch (mode = 'initial') and when adding an
   * additional account (mode = 'add-account').
   *
   * Validates the email locally before dispatching SIGN_IN_NEW to the service
   * worker. Sign-in progress and errors are driven by the `states` store via
   * props from App.svelte rather than local async state, so the UI stays
   * correct even if the popup is closed and reopened mid-flow.
   */
  import { tick } from 'svelte';
  import { GLOBALS } from '../constants';
  import msSignInDarkUrl from '../assets/ms-signin-dark.svg?url';
  import { Button, Input, Spinner, Alert } from './components/ui/index.js';
  import { ChevronDown } from '@lucide/svelte';

  import { sendCommand, MessageType } from '../types/messages.js';
  import { isValidEmail } from '../tools/oauth.js';

  let { mode = 'initial', signInPending, signInError = null, onBack, onOpenDebug }: {
    mode: 'initial' | 'add-account';
    signInPending: boolean;
    signInError?: string | null;
    onBack: () => void;
    onOpenDebug: () => void;
  } = $props();

  let username = $state('');
  let tenant = $state('');
  let advancedOpen = $state(false);
  let copyFeedback = $state(false);
  /** Error message shown in the alert banner. Mirrors `signInError` and can be cleared locally. */
  let localError = $state<string | null>(null);

  $effect(() => {
    localError = signInError ?? null;
  });

  // When sliding in as add-account, the AccountSwitcher's Bits UI focus trap may still
  // be releasing. Programmatic focus overrides it once the transition settles.
  $effect(() => {
    if (mode === 'add-account') {
      tick().then(() => {
        (document.getElementById('username') as HTMLInputElement | null)?.focus();
      });
    }
  });

  /**
   * Validates the username and dispatches the SIGN_IN_NEW command.
   * No-ops while a sign-in is already in progress.
   */
  function handleSignIn() {
    if (!username.trim() || signInPending) return;
    if (!isValidEmail(username.trim())) {
      localError = 'Please enter a valid email address.';
      return;
    }
    localError = null;
    sendCommand(MessageType.SIGN_IN_NEW, { username: username.trim(), tenantId: tenant.trim() || undefined });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') handleSignIn();
  }

  /**
   * Copies the admin consent URL for the commercial/GCC app registration to
   * the clipboard and shows brief visual feedback.
   */
  async function copyConsentUrl() {
    const clientId = GLOBALS.CLIENT_ID.GLOBAL;
    if (!clientId) return;
    const url = GLOBALS.CONSENT_URL.GLOBAL(clientId);
    await navigator.clipboard.writeText(url);
    copyFeedback = true;
    setTimeout(() => (copyFeedback = false), 2000);
  }
</script>

<div class="flex flex-col h-full bg-surface-900 text-text-primary overflow-y-auto">
  <div class="flex flex-col flex-1 px-6 py-8 gap-5">
    <!-- Title -->
    <div class="flex flex-col gap-1">
      <h1 class="text-xl font-bold text-text-primary">
        {mode === 'add-account' ? 'Add Account' : 'Welcome to Privly'}
      </h1>
      <p class="text-sm text-text-muted">
        {mode === 'add-account'
          ? 'Sign in with another Microsoft account'
          : 'Sign in with your Microsoft account to manage PIM roles'}
      </p>
    </div>

    <!-- Pending banner -->
    {#if signInPending}
      <div class="flex items-center gap-3 px-4 py-3 rounded-lg bg-brand-primary/20 border border-brand-primary/40">
        <Spinner />
        <span class="text-sm text-brand-secondary">Waiting for sign-in to complete...</span>
      </div>
    {/if}

    <!-- Error alert -->
    {#if localError}
      <Alert type="error" message={localError} onDismiss={() => (localError = null)} />
    {/if}

    <!-- Username input -->
    <!-- svelte-ignore a11y_autofocus -->
    <Input
      id="username"
      type="email"
      label="Email or username"
      bind:value={username}
      onkeydown={handleKeydown}
      autofocus
      placeholder="user@contoso.com"
    />

    <!-- Advanced section -->
    <div class="flex flex-col gap-0">
      <button
        type="button"
        onclick={() => (advancedOpen = !advancedOpen)}
        aria-expanded={advancedOpen}
        aria-controls="advanced-section"
        class="section-toggle"
      >
        Advanced
        <ChevronDown class="ml-auto section-toggle-icon text-brand-tertiary {advancedOpen ? '' : '-rotate-90'}" aria-hidden="true" />
      </button>

      <div
        id="advanced-section"
        inert={!advancedOpen}
        class="overflow-hidden transition-all duration-200 {advancedOpen ? 'max-h-64 opacity-100' : 'max-h-0 opacity-0'}"
      >
        <div class="flex flex-col gap-4 pt-2">
          <!-- Tenant ID -->
          <Input
            id="tenant"
            type="text"
            label="Tenant ID (optional)"
            bind:value={tenant}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            class="text-xs"
          />

          <!-- Admin Consent URLs -->
          <div class="flex flex-col gap-2">
            <span class="text-xs text-text-tertiary font-medium uppercase tracking-wide">Admin Consent URLs</span>
            <div class="flex gap-2">
              <Button
                variant="brand"
                class="flex-1"
                onclick={copyConsentUrl}
                aria-label="Copy Commercial/GCC admin consent URL"
              >
                {copyFeedback ? 'Copied!' : 'Commercial / GCC'}
              </Button>
              <div class="relative flex-1">
                <button
                  type="button"
                  disabled
                  aria-label="Government admin consent URL (coming soon)"
                  class="w-full px-3 py-2 rounded-lg text-xs bg-surface-700 text-text-disabled border border-surface-500 cursor-not-allowed"
                >
                  Government
                </button>
                <span class="absolute -top-1.5 -left-1 text-[9px] bg-status-amber-muted text-status-amber border border-status-amber-border rounded px-1 py-0.5 leading-none">
                  Soon
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Sign-in button -->
    <div class="flex flex-col gap-3">
      <button
        type="button"
        onclick={handleSignIn}
        aria-disabled={signInPending || !username.trim()}
        class="w-fit mx-auto aria-disabled:opacity-40 aria-disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
      >
        <img src={msSignInDarkUrl} alt="Sign in with Microsoft" class="h-10" />
      </button>

      {#if mode === 'add-account'}
        <Button variant="ghost" class="w-full" onclick={onBack}>
          Cancel
        </Button>
      {/if}
    </div>

    <div class="flex flex-col gap-3">
      <span class="text-center">
        <!--
        <Button variant="ghost" onclick={() => window.open("https://support.tripointlabs.com")}>
          Documentation
        </Button>
        -->
        <Button variant="ghost" onclick={() => window.open("https://support.tripointlabs.com")}>
          Support
        </Button>
        <Button variant="ghost" onclick={onOpenDebug} aria-label="Open the debug panel">
          Debug
        </Button>
      </span>
    </div>
  </div>

  <!-- Footer -->
  <div class="px-6 py-4 text-center">
    <p class="text-xs text-text-ghost">Made with ❤️ by TriPoint Labs</p>
    <p class="text-xs text-text-ghost">Copyright &copy; {new Date().getFullYear()} TriPoint Labs, LLC</p>
  </div>
</div>
