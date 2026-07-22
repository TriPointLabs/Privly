<script lang="ts">
  /**
   * User avatar with optional photo and a cloud-type badge overlay.
   *
   * Displays the account photo when `photoDataUrl` is provided; otherwise
   * falls back to a colored circle with the user's initials. A shield icon
   * is shown for government clouds (GCCH, DoD); a globe icon for commercial.
   */
  import type { CloudType } from '../../../tools/db.js';

  let {
    displayName,
    photoDataUrl = null,
    cloud,
    size = 'md',
  }: {
    displayName: string;
    photoDataUrl: string | null;
    cloud: CloudType;
    size?: 'sm' | 'md' | 'lg';
  } = $props();

  function getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  }

  const isGovernment = $derived(cloud === 'gcch' || cloud === 'dod');

  const avatarClass = $derived(
    size === 'sm' ? 'w-7 h-7 text-xs' :
    size === 'lg' ? 'w-14 h-14 text-base' :
    'w-8 h-8 text-xs'
  );
  const badgeClass = $derived(
    size === 'sm' ? 'w-3 h-3 -bottom-0.5 -right-0.5' :
    size === 'lg' ? 'w-5 h-5 -bottom-0.5 -right-0.5' :
    'w-3.5 h-3.5 -bottom-0.5 -right-0.5'
  );
  const iconClass = $derived(
    size === 'sm' ? 'w-1.5 h-1.5' :
    size === 'lg' ? 'w-3 h-3' :
    'w-2 h-2'
  );
</script>

<div class="relative shrink-0 {avatarClass}">
  {#if photoDataUrl}
    <img
      src={photoDataUrl}
      alt=""
      aria-hidden="true"
      class="w-full h-full rounded-full object-cover"
    />
  {:else}
    <div class="w-full h-full rounded-full bg-brand-primary flex items-center justify-center">
      <span class="font-bold text-text-on-brand">{getInitials(displayName)}</span>
    </div>
  {/if}

  <!-- Cloud type badge -->
  <span
    class="absolute {badgeClass} rounded-full bg-surface-900 flex items-center justify-center"
    aria-hidden="true"
  >
    {#if isGovernment}
      <!-- Shield icon -->
      <svg class="{iconClass} text-status-amber" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.25C17.25 22.15 21 17.25 21 12V7l-9-5z"/>
      </svg>
    {:else}
      <!-- Globe icon -->
      <svg class="{iconClass} text-brand-secondary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" stroke-linecap="round"/>
      </svg>
    {/if}
  </span>
</div>
