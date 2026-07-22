<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';

  let {
    label,
    id,
    value = $bindable(''),
    class: className = '',
    ...rest
  }: { label?: string; class?: string; value?: string } & HTMLInputAttributes = $props();
</script>

{#if label}
  <div class="flex flex-col gap-1.5">
    <label for={id} class="field-label">
      {label}
    </label>
    <input
      {id}
      bind:value
      class="field-input {className}"
      {...rest}
    />
  </div>
{:else}
  <input
    {id}
    class="field-input {className}"
    {...rest}
  />
{/if}
