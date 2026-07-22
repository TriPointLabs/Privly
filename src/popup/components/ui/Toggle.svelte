<script lang="ts">
  let {
    checked = $bindable(false),
    disabled = false,
    id,
    'aria-label': ariaLabel,
    onchange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    id?: string;
    'aria-label'?: string;
    onchange?: (checked: boolean) => void;
  } = $props();
</script>

<button
  type="button"
  role="switch"
  {id}
  aria-label={ariaLabel}
  aria-checked={checked}
  {disabled}
  onclick={() => {
    if (!disabled) {
      checked = !checked;
      onchange?.(checked);
    }
  }}
  class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-secondary disabled:cursor-not-allowed disabled:opacity-50
    {checked ? 'bg-brand-secondary' : 'bg-surface-500'}"
>
  <span
    class="pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-toggle-knob shadow transition-transform
      {checked ? 'translate-x-[18px]' : 'translate-x-[3px]'}"
  ></span>
</button>
