<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    class: className = '',
    children,
  }: { class?: string; children?: Snippet } = $props();
</script>

<div class="px-3 py-2.5 rounded-lg bg-surface-800 border border-surface-600 {className}">
  {@render children?.()}
</div>
