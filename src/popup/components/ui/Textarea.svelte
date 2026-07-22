<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';

  let {
    label,
    id,
    value = $bindable(''),
    rows = 3,
    class: className = '',
    ...rest
  }: { label?: string; id?: string; rows?: number; class?: string; value?: string } & HTMLTextareaAttributes = $props();
</script>

{#if label}
  <div class="flex flex-col gap-1.5">
    <label for={id} class="field-label">{label}</label>
    <textarea {id} {rows} bind:value
      class="field-input resize-none {className}"
      {...rest}></textarea>
  </div>
{:else}
  <textarea {id} {rows} bind:value
    class="field-input resize-none {className}"
    {...rest}></textarea>
{/if}
