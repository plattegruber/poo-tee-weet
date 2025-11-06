<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { UserButton, useClerkContext } from 'svelte-clerk/client';

  type DocumentResponse = {
    document: {
      docId: string;
      title: string;
      content: string;
      tags: string[];
      createdAt: string;
      updatedAt: string;
      version: number;
    };
  };

  const workerBaseUrl = import.meta.env.VITE_WORKER_BASE_URL;

  if (!workerBaseUrl) {
    throw new Error(
      'Missing VITE_WORKER_BASE_URL. Point it at your Cloudflare Worker origin.'
    );
  }

  const TOKEN_TEMPLATE = 'poo-tee-weet';
  const SAVE_DEBOUNCE_MS = 1500;
  const DEFAULT_MARKUP = `<p>A distraction free writing tool.</p><p>So it goes.</p>`;
  const isBrowser = typeof window !== 'undefined';

  const clerk = useClerkContext();

  let editor: HTMLElement | null = null;
  let docId: string | null = null;
  let pendingSave: ReturnType<typeof setTimeout> | null = null;
  let hasInitialized = false;

  let isSaving = $state(false);
  let isDirty = $state(false);
  let saveError = $state<string | null>(null);
  let lastSavedAt = $state<string | null>(null);

  const storageKey = $derived.by(() => {
    const sessionId = clerk.session?.id ?? null;
    return sessionId ? `ptw-doc-${sessionId}` : null;
  });

  const formatTimestamp = (iso: string) => {
    try {
      const value = new Date(iso);
      return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  const computeTitle = (html: string) => {
    if (typeof document === 'undefined') {
      return 'Untitled';
    }
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const text = temp.textContent ?? '';
    const candidate = text.split('\n').map((line) => line.trim()).find(Boolean);
    if (!candidate) return 'Untitled';
    return candidate.slice(0, 120);
  };

  const getSessionToken = async () => {
    if (!clerk.session) {
      throw new Error('Missing Clerk session; cannot authenticate request.');
    }
    const token = await clerk.session.getToken({ template: TOKEN_TEMPLATE } as any);
    if (!token) {
      throw new Error('Unable to retrieve Clerk session token.');
    }
    return token;
  };

  const apiRequest = async (path: string, init: RequestInit = {}) => {
    const token = await getSessionToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    try {
      return await fetch(`${workerBaseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : 'Request to Worker failed.'
      );
    }
  };

  const loadExistingDocument = async (candidateId: string) => {
    const response = await apiRequest(`/docs/${candidateId}`, { method: 'GET' });

    if (response.status === 404) {
      return false;
    }

    if (!response.ok) {
      saveError = `Failed to load document (${response.status}).`;
      return false;
    }

    const payload = (await response.json()) as DocumentResponse;

    docId = payload.document.docId;
    lastSavedAt = payload.document.updatedAt;
    saveError = null;
    isDirty = false;

    if (editor) {
      editor.innerHTML = payload.document.content || DEFAULT_MARKUP;
    }

    return true;
  };

  const createDocument = async (key: string) => {
    const initialContent = editor?.innerHTML ?? DEFAULT_MARKUP;
    const response = await apiRequest('/me/docs', {
      method: 'POST',
      body: JSON.stringify({
        title: computeTitle(initialContent),
        content: initialContent,
        tags: [],
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        message ? `Document creation failed: ${message}` : 'Document creation failed.'
      );
    }

    const payload = (await response.json()) as DocumentResponse;
    docId = payload.document.docId;
    lastSavedAt = payload.document.updatedAt;
    saveError = null;
    isDirty = false;

    if (isBrowser) {
      window.localStorage.setItem(key, docId);
    }
  };

  const initializeDocument = async () => {
    if (!storageKey) return;
    if (!editor) return;

    const cachedId =
      isBrowser && storageKey ? window.localStorage.getItem(storageKey) : null;

    if (cachedId) {
      const loaded = await loadExistingDocument(cachedId);
      if (loaded) {
        return;
      }
      if (isBrowser) {
        window.localStorage.removeItem(storageKey);
      }
    }

    await createDocument(storageKey);
    if (editor && editor.innerHTML.trim().length === 0) {
      editor.innerHTML = DEFAULT_MARKUP;
    }
  };

  const saveDocument = async (force = false) => {
    if (!docId || !editor) return;
    if (!isDirty && !force) return;

    const content = editor.innerHTML;
    const title = computeTitle(content);

    isSaving = true;
    saveError = null;

    const response = await apiRequest(`/docs/${docId}`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        content,
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      saveError = message || `Save failed (${response.status})`;
    } else {
      const payload = (await response.json()) as DocumentResponse;
      lastSavedAt = payload.document.updatedAt;
      isDirty = false;
    }

    isSaving = false;
  };

  const scheduleSave = (immediate = false) => {
    if (pendingSave) {
      clearTimeout(pendingSave);
      pendingSave = null;
    }

    if (!docId) return;

    pendingSave = setTimeout(() => {
      pendingSave = null;
      void saveDocument(immediate);
    }, immediate ? 0 : SAVE_DEBOUNCE_MS);
  };

  const flushPendingSave = async () => {
    if (pendingSave) {
      clearTimeout(pendingSave);
      pendingSave = null;
      await saveDocument(true);
    } else {
      await saveDocument(true);
    }
  };

  const handleInput = () => {
    isDirty = true;
    scheduleSave(false);
  };

  const handleBlur = () => {
    scheduleSave(true);
  };

  const handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!isDirty) return;
    event.preventDefault();
    event.returnValue = '';
  };

  onMount(() => {
    editor?.focus();
    if (isBrowser) {
      window.addEventListener('beforeunload', handleBeforeUnload);
    }
  });

  onDestroy(() => {
    if (isBrowser) {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    }
    void flushPendingSave();
  });

  $effect(() => {
    if (!hasInitialized && clerk.isLoaded && clerk.session && editor) {
      hasInitialized = true;
      void initializeDocument().catch((error) => {
        saveError = error instanceof Error ? error.message : String(error);
      });
    }
  });
</script>

<section class="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-6 pb-24 pt-16">
  <main
    class="tab-size-4 w-full flex-1 text-lg leading-relaxed focus:outline-none"
    bind:this={editor}
    contenteditable="true"
    spellcheck="false"
    autocapitalize="off"
    translate="no"
    lang="en"
    aria-label="Writing editor"
    oninput={handleInput}
    onblur={handleBlur}
    data-testid="editor"
  >
    <p>A distraction free writing tool.</p>
    <p>So it goes.</p>
  </main>

  <div class="mt-6 text-sm leading-heading" role="status" aria-live="polite">
    {#if saveError}
      <span class="inline-flex items-center gap-1 text-editor-error">
        We hit a snag saving: {saveError}
      </span>
    {:else if isSaving}
      <span class="inline-flex items-center gap-1 text-editor-busy">Saving…</span>
    {:else if lastSavedAt}
      <span class="inline-flex items-center gap-1 text-editor-ok">
        Saved at {formatTimestamp(lastSavedAt)}
      </span>
    {:else}
      <span class="inline-flex items-center gap-1 text-editor-busy">All changes saved.</span>
    {/if}
  </div>
</section>

<div class="fixed right-6 top-6 z-10">
  <UserButton afterSignOutUrl="#/sign-in" />
</div>
