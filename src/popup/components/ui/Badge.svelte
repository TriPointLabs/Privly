<script lang="ts">
  import type { Snippet } from 'svelte';

  type Color = 'surface' | 'brand' | 'amber' | 'green' | 'red';

  let {
    color,
    pill = false,
    class: className = '',
    children,
  }: { color: Color; pill?: boolean; class?: string; children?: Snippet } = $props();

  const colors: Record<Color, string> = {
    surface: 'bg-surface-700 text-text-tertiary border border-surface-500',
    brand: 'bg-brand-primary/20 text-brand-secondary border border-brand-primary/30',
    amber: 'bg-status-amber-muted text-status-amber border border-status-amber-border',
    green: 'bg-status-green-muted text-status-green border border-status-green-border',
    red: 'bg-status-red-muted text-status-red border border-status-red-border',
  };

  const shape = $derived(pill
    ? 'rounded-full px-1.5 py-0.5'
    : 'rounded px-2 py-0.5');
</script>

<span class="text-[10px] font-medium leading-none {shape} {colors[color]} {className}">
  {@render children?.()}
</span>
