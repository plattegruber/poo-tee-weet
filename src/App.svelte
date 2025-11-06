<script lang="ts">
  import {
    ClerkLoaded,
    ClerkLoading,
    ClerkProvider,
    SignedIn,
    SignedOut,
  } from 'svelte-clerk/client';
  import SignedInView from './components/SignedInView.svelte';
  import SignedOutView from './components/SignedOutView.svelte';

  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

  if (!publishableKey) {
    throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY. Set it in your environment.');
  }

  const afterAuthUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : '/';
</script>

<div class="min-h-screen bg-editor-background font-body text-editor-text">
  <ClerkProvider publishableKey={publishableKey}>
    <ClerkLoading>
      <main
        class="flex min-h-screen items-center justify-center px-6 py-12"
        aria-busy="true"
        contenteditable="false"
        lang="en"
        aria-label="Loading authentication state"
      >
        <p class="text-lg font-heading leading-heading text-editor-busy">Loading…</p>
      </main>
    </ClerkLoading>

    <ClerkLoaded>
      <SignedIn>
        <SignedInView />
      </SignedIn>

      <SignedOut>
        <SignedOutView afterAuthUrl={afterAuthUrl} />
      </SignedOut>
    </ClerkLoaded>
  </ClerkProvider>
</div>
