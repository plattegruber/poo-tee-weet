<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { SignIn, SignUp } from 'svelte-clerk/client';

  const { afterAuthUrl } = $props<{ afterAuthUrl: string }>();

  type Screen = 'signIn' | 'signUp';

  const signInHash = '#/sign-in';
  const signUpHash = '#/sign-up';

  let screen = $state<Screen>('signIn');

  const syncFromHash = () => {
    if (typeof window === 'undefined') return;
    screen = window.location.hash === signUpHash ? 'signUp' : 'signIn';
  };

  const setHash = (next: Screen) => {
    if (typeof window === 'undefined') return;
    window.location.hash = next === 'signUp' ? signUpHash : signInHash;
  };

  const showSignIn = () => {
    screen = 'signIn';
    setHash('signIn');
  };

  const showSignUp = () => {
    screen = 'signUp';
    setHash('signUp');
  };

  const sharedProps = {
    routing: 'hash' as const,
    afterSignInUrl: afterAuthUrl,
    afterSignUpUrl: afterAuthUrl,
    signInUrl: signInHash,
    signUpUrl: signUpHash,
  };

  onMount(() => {
    syncFromHash();
    if (typeof window !== 'undefined') {
      window.addEventListener('hashchange', syncFromHash);
    }
  });

  onDestroy(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('hashchange', syncFromHash);
  });
</script>

<main
  class="flex min-h-screen items-center justify-center px-4 py-16"
  aria-busy="false"
  contenteditable="false"
  lang="en"
  aria-label="Authentication forms"
>
  <div class="flex w-full max-w-md flex-col items-center gap-6">
    {#if screen === 'signUp'}
      <SignUp {...sharedProps} />
      <p class="text-center font-heading text-sm leading-heading">
        Already have an account?
        <button
          class="ml-1 bg-transparent font-semibold text-accent underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent hover:underline"
          type="button"
          onclick={showSignIn}
        >
          Sign in
        </button>
      </p>
    {:else}
      <SignIn {...sharedProps} />
      <p class="text-center font-heading text-sm leading-heading">
        Need an account?
        <button
          class="ml-1 bg-transparent font-semibold text-accent underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent hover:underline"
          type="button"
          onclick={showSignUp}
        >
          Sign up
        </button>
      </p>
    {/if}
  </div>
</main>
