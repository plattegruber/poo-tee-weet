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
  const DEFAULT_TITLE = 'Welcome to poo-tee-weet';
  const DEFAULT_UNTITLED = 'Untitled';
  const DEFAULT_BODY = `<p>A distraction free writing tool.</p><p>So it goes.</p>`;
  const DEFAULT_MARKUP = `<h1>${DEFAULT_TITLE}</h1>${DEFAULT_BODY}`;
  const isBrowser = typeof window !== 'undefined';

  const clerk = useClerkContext();

  let titleElement: HTMLElement | null = null;
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

  const sanitizeTitleText = (value: string) => {
    return value.replace(/\s+/g, ' ').trim().slice(0, 120);
  };

  const resolveTitleText = (value: string | null | undefined) => {
    const sanitized = sanitizeTitleText(value ?? '');
    return sanitized || DEFAULT_UNTITLED;
  };

  const escapeHtml = (value: string) => {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  const splitDocumentContent = (html: string) => {
    if (typeof document === 'undefined') {
      return {
        titleText: DEFAULT_TITLE,
        bodyHtml: html,
      };
    }

    const temp = document.createElement('div');
    temp.innerHTML = html;
    const heading = temp.querySelector('h1');
    let titleText = DEFAULT_TITLE;

    if (heading) {
      titleText = resolveTitleText(heading.textContent ?? DEFAULT_TITLE);
      heading.remove();
    } else {
      let candidateNode: ChildNode | null = temp.firstChild;

      while (
        candidateNode &&
        candidateNode.nodeType === Node.TEXT_NODE &&
        !(candidateNode.textContent ?? '').trim()
      ) {
        const toRemove = candidateNode;
        candidateNode = candidateNode.nextSibling;
        temp.removeChild(toRemove);
      }

      if (candidateNode && candidateNode.nodeType === Node.ELEMENT_NODE) {
        const element = candidateNode as HTMLElement;
        titleText = resolveTitleText(element.textContent ?? DEFAULT_UNTITLED);
        element.remove();
      } else if (candidateNode && candidateNode.nodeType === Node.TEXT_NODE) {
        titleText = resolveTitleText(candidateNode.textContent ?? DEFAULT_UNTITLED);
        candidateNode.remove();
      } else {
        const text = temp.textContent ?? '';
        const fallback = text.split('\n').map((line) => line.trim()).find(Boolean);
        if (fallback) {
          titleText = resolveTitleText(fallback);
        }
      }
    }

    const bodyHtml = temp.innerHTML.trim();

    return {
      titleText,
      bodyHtml,
    };
  };

  const computeTitle = (html: string) => {
    if (typeof document === 'undefined') {
      return DEFAULT_TITLE;
    }
    const { titleText } = splitDocumentContent(html);
    return titleText || DEFAULT_UNTITLED;
  };

  const applyDocumentContent = (titleText: string, bodyHtml: string) => {
    if (titleElement) {
      titleElement.textContent = titleText || DEFAULT_TITLE;
    }

    if (editor) {
      editor.innerHTML = bodyHtml ?? '';
    }
  };

  const serializeDocument = () => {
    const titleTextRaw = titleElement?.textContent ?? '';
    const titleText = resolveTitleText(titleTextRaw);
    const bodyHtml = editor?.innerHTML ?? DEFAULT_BODY;
    return `<h1>${escapeHtml(titleText)}</h1>${bodyHtml}`;
  };

  const placeCaretAtStart = (element: HTMLElement) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const placeCaretAtEnd = (element: HTMLElement) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const hasPriorContent = (fragment: DocumentFragment) => {
    for (const node of Array.from(fragment.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent ?? '').trim().length > 0) {
          return true;
        }
        continue;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const elementNode = node as HTMLElement;
        if ((elementNode.textContent ?? '').trim().length > 0) {
          return true;
        }
        continue;
      }

      return true;
    }
    return false;
  };

  const isSelectionAtContentStart = (element: HTMLElement) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return false;
    }

    const range = selection.getRangeAt(0);
    if (!range.collapsed) {
      return false;
    }

    if (!element.contains(range.startContainer)) {
      return false;
    }

    const preRange = range.cloneRange();
    preRange.selectNodeContents(element);
    try {
      preRange.setEnd(range.startContainer, range.startOffset);
    } catch {
      return false;
    }

    if (!preRange.collapsed) {
      const preceding = preRange.cloneContents();
      if (hasPriorContent(preceding)) {
        return false;
      }
    }

    return true;
  };

  const focusEditorAtStart = () => {
    if (!editor) return;
    editor.focus();
    placeCaretAtStart(editor);
  };

  const focusTitleAtEnd = () => {
    if (!titleElement) return;
    titleElement.focus();
    placeCaretAtEnd(titleElement);
  };

  const handleTitleKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' || event.shiftKey) {
      return;
    }
    if (!editor) return;
    event.preventDefault();
    focusEditorAtStart();
  };

  const handleEditorKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowUp' || event.shiftKey) {
      return;
    }
    if (!editor || !titleElement) return;
    if (!isSelectionAtContentStart(editor)) {
      return;
    }
    event.preventDefault();
    focusTitleAtEnd();
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

    const { titleText, bodyHtml } = splitDocumentContent(
      payload.document.content || DEFAULT_MARKUP
    );

    applyDocumentContent(titleText, bodyHtml);

    return true;
  };

  const createDocument = async (key: string) => {
    const initialContent = serializeDocument();
    const initialTitle =
      resolveTitleText(titleElement?.textContent ?? '') || computeTitle(initialContent);

    const response = await apiRequest('/me/docs', {
      method: 'POST',
      body: JSON.stringify({
        title: initialTitle,
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
    if (titleElement && !sanitizeTitleText(titleElement.textContent ?? '')) {
      titleElement.textContent = DEFAULT_TITLE;
    }
    if (editor && editor.innerHTML.trim().length === 0) {
      editor.innerHTML = DEFAULT_BODY;
    }
  };

  const saveDocument = async (force = false) => {
    if (!docId || !editor) return;
    if (!isDirty && !force) return;

    const content = serializeDocument();
    const title = resolveTitleText(titleElement?.textContent ?? '') || DEFAULT_TITLE;

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

  const handleTitleBlur = () => {
    if (titleElement && !sanitizeTitleText(titleElement.textContent ?? '')) {
      titleElement.textContent = DEFAULT_UNTITLED;
    }
    handleBlur();
  };

  const handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!isDirty) return;
    event.preventDefault();
    event.returnValue = '';
  };

  onMount(() => {
    if (titleElement) {
      titleElement.focus();
    } else {
      editor?.focus();
    }
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
  <h1
    class="mb-6 w-full text-4xl font-heading leading-tight focus:outline-none"
    bind:this={titleElement}
    contenteditable="true"
    spellcheck="false"
    autocapitalize="off"
    translate="no"
    lang="en"
    aria-label="Document title"
    oninput={handleInput}
    onblur={handleTitleBlur}
    onkeydown={handleTitleKeydown}
    data-testid="editor-title"
  >
    {DEFAULT_TITLE}
  </h1>

  <div
    class="tab-size-4 w-full flex-1 text-lg leading-relaxed focus:outline-none"
    bind:this={editor}
    contenteditable="true"
    spellcheck="false"
    autocapitalize="off"
    translate="no"
    lang="en"
    aria-label="Writing editor"
    role="textbox"
    aria-multiline="true"
    tabindex="0"
    oninput={handleInput}
    onblur={handleBlur}
    onkeydown={handleEditorKeydown}
    data-testid="editor-body"
  >
    {@html DEFAULT_BODY}
  </div>

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
