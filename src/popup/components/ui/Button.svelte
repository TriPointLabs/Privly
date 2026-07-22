<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  type Variant =
    | 'icon'
    | 'icon-lg'
    | 'icon-danger'
    | 'brand'
    | 'approve'
    | 'deny'
    | 'ghost'
    | 'danger';

  let {
    variant,
    class: className = '',
    children,
    ...rest
  }: { variant: Variant; class?: string; children?: Snippet } & HTMLButtonAttributes = $props();

  const base = 'transition-colors focus-visible:ring-1 focus-visible:ring-brand-secondary';

  const variants: Record<Variant, string> = {
    'icon': 'p-1 rounded text-text-faint hover:text-text-primary hover:bg-surface-700',
    'icon-lg': 'p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-700',
    'icon-danger': 'p-1 rounded text-text-faint hover:text-status-red hover:bg-status-red-muted',
    'brand': 'px-3 py-1 rounded text-xs font-medium bg-brand-primary/20 text-brand-secondary border border-brand-primary/30 hover:bg-brand-primary/40',
    'approve': 'py-1.5 px-3 rounded text-xs font-medium bg-status-green-muted text-status-green border border-status-green-border hover:bg-status-green-border',
    'deny': 'py-1.5 px-3 rounded text-xs font-medium bg-status-red-muted text-status-red border border-status-red-border hover:bg-status-red-border',
    'ghost': 'py-2 px-3 rounded-lg text-sm text-text-tertiary hover:text-text-primary hover:bg-surface-700',
    'danger': 'py-2 px-3 rounded-lg text-sm text-status-red bg-status-red-muted border border-status-red-border hover:bg-status-red-border',
  };
</script>

<button type="button" class="{base} {variants[variant]} {className}" {...rest}>
  {@render children?.()}
</button>
