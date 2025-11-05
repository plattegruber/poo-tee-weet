<script lang="ts">
  import { onMount } from 'svelte';
  import { UserButton } from 'svelte-clerk/client';

  let editor: HTMLElement | null = null;

  onMount(() => {
    editor?.focus();
  });
</script>

<main
  bind:this={editor}
  contenteditable="true"
  spellcheck="false"
  autocapitalize="off"
  translate="no"
  lang="en"
  aria-label="Markdown editor"
  style="tab-size: 4"
>
  <p>A distraction free writing tool.</p>
  <p>So it goes.</p>
</main>

<div class="user-button">
  <UserButton afterSignOutUrl="#/sign-in" />
</div>
