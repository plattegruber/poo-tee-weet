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

  // Clerk renders its own form; this maps it onto the paper/plum tokens so it
  // reads as part of the page rather than a card dropped onto it.
  const appearance = {
    variables: {
      colorPrimary: '#6E3E78',
      colorPrimaryForeground: '#F7F2E9',
      colorBackground: '#F7F2E9',
      colorForeground: '#1E1A1F',
      colorMutedForeground: '#6B636C',
      colorInput: '#DBD1BF',
      colorInputBackground: '#F1EBDF',
      colorInputForeground: '#1E1A1F',
      colorNeutral: '#1E1A1F',
      colorDanger: '#9E4A33',
      colorSuccess: '#4F6B4A',
      colorWarning: '#A3781C',
      colorRing: '#6E3E78',
      colorBorder: '#DBD1BF',
      colorShadow: 'rgba(30, 26, 31, 0.08)',
      fontFamily: '"Public Sans", system-ui, -apple-system, sans-serif',
      fontFamilyButtons: '"Public Sans", system-ui, -apple-system, sans-serif',
      fontSize: '15px',
      fontWeight: { normal: 400, medium: 500, semibold: 500, bold: 500 },
      borderRadius: '3px',
    },
    elements: {
      rootBox: 'w-full',
      cardBox: 'w-full max-w-form shadow-none rounded-none',
      card: 'bg-transparent shadow-none rounded-none border-0 p-0',
      header: 'hidden',
      main: 'gap-4',
      formFieldLabel: 'text-sm font-regular text-text-muted',
      formFieldInput: 'h-control-md rounded-sm border border-border-subtle bg-surface-raised px-3 text-md shadow-none',
      formButtonPrimary:
        'h-control-lg rounded-md bg-accent text-md font-medium normal-case text-accent-on shadow-none hover:bg-accent-hover focus:bg-accent-hover active:bg-accent-active',
      socialButtonsBlockButton:
        'h-control-md rounded-md border border-border-strong bg-transparent text-text-body shadow-none hover:bg-surface-sunken',
      dividerLine: 'bg-border-subtle',
      dividerText: 'text-text-faint',
      footer: 'hidden',
      formFieldErrorText: 'text-sm text-danger',
      identityPreview: 'border-border-subtle bg-surface-raised',
      identityPreviewText: 'text-text-body',
      identityPreviewEditButton: 'text-text-accent',
      otpCodeFieldInput: 'border-border-subtle bg-surface-raised',
      alternativeMethodsBlockButton: 'border-border-subtle text-text-body',
      formResendCodeLink: 'text-text-accent',
    },
  };

  const sharedProps = $derived({
    routing: 'hash' as const,
    afterSignInUrl: afterAuthUrl,
    afterSignUpUrl: afterAuthUrl,
    signInUrl: signInHash,
    signUpUrl: signUpHash,
    appearance,
  });

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
  class="flex min-h-screen flex-col items-center justify-center px-6 py-16"
  lang="en"
  aria-label={screen === 'signUp' ? 'Create an account' : 'Sign in'}
>
  <h1 class="mb-12 font-display text-2xl font-regular leading-tight tracking-tight text-text-body">
    poo-tee-weet
  </h1>

  <div class="flex w-full max-w-form flex-col items-center">
    {#if screen === 'signUp'}
      <SignUp {...sharedProps} />
    {:else}
      <SignIn {...sharedProps} />
    {/if}
  </div>

  <p class="mt-8 text-sm text-text-faint">
    {#if screen === 'signUp'}
      Already have an account?
      <button
        type="button"
        class="cursor-pointer border-0 bg-transparent p-0 font-ui text-sm text-text-muted underline decoration-1 underline-offset-2 transition-colors duration-fast ease-out hover:text-text-body"
        onclick={showSignIn}
      >
        Sign in
      </button>
    {:else}
      <button
        type="button"
        class="cursor-pointer border-0 bg-transparent p-0 font-ui text-sm text-text-muted underline decoration-1 underline-offset-2 transition-colors duration-fast ease-out hover:text-text-body"
        onclick={showSignUp}
      >
        Create an account
      </button>
    {/if}
  </p>
</main>
