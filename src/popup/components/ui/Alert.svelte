<script lang="ts">
  import { onMount } from 'svelte';
  import { X } from '@lucide/svelte';

  let { type, message, onDismiss }: {
    type: 'success' | 'error' | 'info';
    message: string;
    onDismiss: () => void;
  } = $props();

  const colorMap = {
    success: 'bg-status-green-muted border-status-green-border text-status-green',
    error: 'bg-status-red-muted border-status-red-border text-status-red',
    info: 'bg-brand-primary/20 border-brand-primary/40 text-brand-secondary',
  };

  const dotColor = {
    success: 'bg-status-green',
    error: 'bg-status-red',
    info: 'bg-brand-secondary',
  };

  let el: HTMLDivElement;

  onMount(() => {
    const t = setTimeout(onDismiss, 4000);
    el.focus();
    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    }
    el.addEventListener('keydown', handleKeydown);
    return () => {
      clearTimeout(t);
      el.removeEventListener('keydown', handleKeydown);
    };
  });
</script>

<div
  bind:this={el}
  class="flex items-start gap-3 px-4 py-3 rounded-lg border {colorMap[type]} focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-secondary"
  role="alert"
  tabindex="-1"
>
  <span class="mt-1 w-2 h-2 rounded-full shrink-0 {dotColor[type]}" aria-hidden="true"></span>
  <span class="flex-1 text-sm leading-snug">{message}</span>
  <button
    type="button"
    onclick={onDismiss}
    aria-label="Dismiss notification"
    class="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
  >
    <X class="w-3.5 h-3.5" aria-hidden="true" />
  </button>
</div>
