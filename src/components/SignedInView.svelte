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

  type DocumentRecord = DocumentResponse['document'];

  type DocumentIndexEntry = {
    docId: string;
    title: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    version: number;
  };

  type DocumentIndexResponse = {
    documents: DocumentIndexEntry[];
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
  const DEFAULT_UNTITLED = '(No title)';
  const DEFAULT_BODY = `<p>A distraction free writing tool.</p><p>So it goes.</p>`;
  const DEFAULT_MARKUP = `<h1>${DEFAULT_TITLE}</h1>${DEFAULT_BODY}`;
  const BLANK_DOCUMENT_MARKUP = '<h1></h1><p><br /></p>';
  const SIDEBAR_HIDE_DELAY_MS = 180;
  const TOUCH_EDGE_THRESHOLD_PX = 32;
  const TOUCH_OPEN_DISTANCE_PX = 48;
  const isBrowser = typeof window !== 'undefined';

  const clerk = useClerkContext();

  let titleElement: HTMLElement | null = null;
  let editor: HTMLElement | null = null;
  let docId = $state<string | null>(null);
  let pendingSave: ReturnType<typeof setTimeout> | null = null;
  let hasInitialized = false;

  let isSaving = $state(false);
  let isDirty = $state(false);
  let saveError = $state<string | null>(null);
  let lastSavedAt = $state<string | null>(null);
  let documents = $state<DocumentIndexEntry[]>([]);
  let isIndexLoading = $state(false);
  let indexError = $state<string | null>(null);
  let isMobileMenuOpen = $state(false);
  let sidebarVisible = $state(false);
  let isSidebarForced = $state(false);
  let hasFrozenOrder = false;
  let sidebarElement: HTMLElement | null = null;
  let sidebarHideTimer: ReturnType<typeof setTimeout> | null = null;
  let isSidebarPointerInside = false;
  let sidebarHasFocus = false;
  let mobileMenuHistoryActive = false;
  let ignoreNextPopStateClose = false;
  let touchStartX: number | null = null;

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

  const toDocumentMetadata = (record: DocumentRecord): DocumentIndexEntry => {
    return {
      docId: record.docId,
      title: record.title,
      tags: record.tags,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version: record.version,
    };
  };

  const normalizeMetadata = (entry: DocumentIndexEntry): DocumentIndexEntry => {
    return {
      ...entry,
      title: resolveTitleText(entry.title),
    };
  };

  const sortByUpdatedAtDesc = (list: DocumentIndexEntry[]) => {
    return [...list].sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  };

  const initializeDocumentIndex = (entries: DocumentIndexEntry[]) => {
    if (hasFrozenOrder && documents.length > 0) {
      return documents;
    }
    const sorted = sortByUpdatedAtDesc(entries).map((entry) => normalizeMetadata(entry));
    documents = sorted;
    hasFrozenOrder = true;
    return sorted;
  };

  const updateDocumentIndexEntry = (
    entry: DocumentIndexEntry,
    options: { insertAtStart?: boolean } = {}
  ) => {
    const normalized = normalizeMetadata(entry);
    const existingIndex = documents.findIndex((item) => item.docId === normalized.docId);

    if (existingIndex === -1) {
      documents = options.insertAtStart
        ? [normalized, ...documents]
        : [...documents, normalized];
      return;
    }

    documents = documents.map((item, index) => {
      return index === existingIndex ? { ...item, ...normalized } : item;
    });
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

  const fetchDocumentIndex = async (): Promise<DocumentIndexEntry[] | null> => {
    isIndexLoading = true;
    indexError = null;

    try {
      const response = await apiRequest('/me/docs', { method: 'GET' });
      if (!response.ok) {
        const message = await response.text();
        indexError = message || `Failed to load documents (${response.status})`;
        return null;
      }

      const payload = (await response.json()) as DocumentIndexResponse;
      const entries = Array.isArray(payload.documents) ? payload.documents : [];
      return initializeDocumentIndex(entries);
    } catch (error) {
      indexError = error instanceof Error ? error.message : String(error);
      return null;
    } finally {
      isIndexLoading = false;
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
    updateDocumentIndexEntry(toDocumentMetadata(payload.document), {
      insertAtStart: true,
    });

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
    updateDocumentIndexEntry(toDocumentMetadata(payload.document));

    if (isBrowser) {
      window.localStorage.setItem(key, docId);
    }
  };

  const initializeDocument = async () => {
    if (!storageKey) return;
    if (!editor) return;

    const cachedId =
      isBrowser && storageKey ? window.localStorage.getItem(storageKey) : null;

    if (cachedId && !docId) {
      const loaded = await loadExistingDocument(cachedId);
      if (!loaded && isBrowser) {
        window.localStorage.removeItem(storageKey);
      }
    }

    const indexEntries = await fetchDocumentIndex();

    if (!docId && indexEntries && indexEntries.length > 0) {
      const primaryId = indexEntries[0].docId;
      const loaded = await loadExistingDocument(primaryId);
      if (loaded && isBrowser) {
        window.localStorage.setItem(storageKey, primaryId);
      }
    }

    if (!docId) {
      await createDocument(storageKey);
      if (titleElement && !sanitizeTitleText(titleElement.textContent ?? '')) {
        titleElement.textContent = DEFAULT_TITLE;
      }
      if (editor && editor.innerHTML.trim().length === 0) {
        editor.innerHTML = DEFAULT_BODY;
      }
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
      updateDocumentIndexEntry(toDocumentMetadata(payload.document));
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

  const updateCurrentDocumentTitle = (value: string) => {
    if (!docId) return;
    const target = documents.find((entry) => entry.docId === docId) ?? null;
    const sanitized = resolveTitleText(value);
    if (target) {
      if (target.title === sanitized) {
        return;
      }
      updateDocumentIndexEntry({ ...target, title: sanitized });
    } else {
      const timestamp = new Date().toISOString();
      updateDocumentIndexEntry({
        docId,
        title: sanitized,
        updatedAt: lastSavedAt ?? timestamp,
        createdAt: lastSavedAt ?? timestamp,
        version: 0,
        tags: [],
      }, { insertAtStart: true });
    }
  };

  const handleTitleInput = () => {
    const raw = titleElement?.textContent ?? '';
    updateCurrentDocumentTitle(raw);
    isDirty = true;
    scheduleSave(false);
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
    updateCurrentDocumentTitle(titleElement?.textContent ?? DEFAULT_UNTITLED);
    handleBlur();
  };

  const handleMobileMenuPopState = () => {
    if (!isBrowser) return;
    if (ignoreNextPopStateClose) {
      ignoreNextPopStateClose = false;
      window.removeEventListener('popstate', handleMobileMenuPopState);
      mobileMenuHistoryActive = false;
      return;
    }
    if (isMobileMenuOpen) {
      isMobileMenuOpen = false;
    }
    window.removeEventListener('popstate', handleMobileMenuPopState);
    mobileMenuHistoryActive = false;
  };

  const openMobileMenu = () => {
    if (isMobileMenuOpen) return;
    isMobileMenuOpen = true;
    if (isBrowser && !mobileMenuHistoryActive) {
      window.addEventListener('popstate', handleMobileMenuPopState);
      window.history.pushState({ __ptwMenu: true }, '', window.location.href);
      mobileMenuHistoryActive = true;
    }
  };

  const closeMobileMenu = (shouldPopHistory = true) => {
    const wasOpen = isMobileMenuOpen;

    if (wasOpen) {
      isMobileMenuOpen = false;
    }

    if (!mobileMenuHistoryActive) {
      return;
    }

    if (isBrowser) {
      if (shouldPopHistory && wasOpen) {
        ignoreNextPopStateClose = true;
        window.history.back();
      } else {
        window.removeEventListener('popstate', handleMobileMenuPopState);
        mobileMenuHistoryActive = false;
      }
    }
  };

  const handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    touchStartX = touch.clientX <= TOUCH_EDGE_THRESHOLD_PX ? touch.clientX : null;
  };

  const handleTouchEnd = (event: TouchEvent) => {
    if (touchStartX === null || event.changedTouches.length === 0) return;
    const touch = event.changedTouches[0];
    if (touch.clientX - touchStartX >= TOUCH_OPEN_DISTANCE_PX) {
      openMobileMenu();
    }
    touchStartX = null;
  };

  const handleTouchCancel = () => {
    touchStartX = null;
  };

  const handleDocumentSelect = async (candidateId: string) => {
    if (!candidateId) return;
    if (candidateId === docId) {
      closeMobileMenu();
      return;
    }

    await flushPendingSave();

    const loaded = await loadExistingDocument(candidateId);
    if (loaded) {
      if (storageKey && isBrowser) {
        window.localStorage.setItem(storageKey, candidateId);
      }
      closeMobileMenu();
    }
  };

  const focusFirstSidebarItem = () => {
    if (!sidebarElement || typeof document === 'undefined') return;
    const button =
      (sidebarElement.querySelector('[data-doc-button]') as HTMLButtonElement | null) ??
      (sidebarElement.querySelector('[data-sidebar-action]') as HTMLButtonElement | null);
    button?.focus();
  };

  const openSidebar = () => {
    if (sidebarHideTimer) {
      clearTimeout(sidebarHideTimer);
      sidebarHideTimer = null;
    }
    sidebarVisible = true;
  };

  const scheduleSidebarHide = () => {
    if (sidebarHideTimer) {
      clearTimeout(sidebarHideTimer);
      sidebarHideTimer = null;
    }
    if (isSidebarPointerInside || sidebarHasFocus || isSidebarForced) {
      return;
    }
    sidebarHideTimer = setTimeout(() => {
      sidebarHideTimer = null;
      if (!isSidebarPointerInside && !sidebarHasFocus && !isSidebarForced) {
        sidebarVisible = false;
      }
    }, SIDEBAR_HIDE_DELAY_MS);
  };

  const handleSidebarPointerEnter = () => {
    isSidebarPointerInside = true;
    isSidebarForced = false;
    openSidebar();
  };

  const handleSidebarPointerLeave = () => {
    isSidebarPointerInside = false;
    scheduleSidebarHide();
  };

  const handleSidebarFocusIn = () => {
    sidebarHasFocus = true;
    openSidebar();
  };

  const handleSidebarFocusOut = () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      sidebarHasFocus = false;
      scheduleSidebarHide();
      return;
    }

    window.requestAnimationFrame(() => {
      if (!sidebarElement) {
        sidebarHasFocus = false;
        scheduleSidebarHide();
        return;
      }
      sidebarHasFocus = sidebarElement.contains(document.activeElement);
      if (!sidebarHasFocus && !isSidebarPointerInside) {
        isSidebarForced = false;
      }
      if (!sidebarHasFocus) {
        scheduleSidebarHide();
      }
    });
  };

  const handleGlobalKeydown = (event: KeyboardEvent) => {
    const key = event.key ? event.key.toLowerCase() : '';

    if ((event.metaKey || event.ctrlKey) && key === 'o') {
      event.preventDefault();
      isSidebarForced = true;
      openSidebar();
      focusFirstSidebarItem();
      return;
    }

    if (key === 'escape') {
      if (isMobileMenuOpen) {
        closeMobileMenu();
        return;
      }
      if (isSidebarForced) {
        isSidebarForced = false;
        scheduleSidebarHide();
      }
    }
  };

  const handleCreateNewDocument = async () => {
    if (!storageKey) return;

    await flushPendingSave();

    try {
      indexError = null;
      const response = await apiRequest('/me/docs', {
        method: 'POST',
        body: JSON.stringify({
          title: DEFAULT_UNTITLED,
          content: BLANK_DOCUMENT_MARKUP,
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
      updateDocumentIndexEntry(toDocumentMetadata(payload.document), {
        insertAtStart: true,
      });

      const { titleText, bodyHtml } = splitDocumentContent(
        payload.document.content || BLANK_DOCUMENT_MARKUP
      );

      applyDocumentContent(titleText, bodyHtml);
      updateCurrentDocumentTitle(titleText);

      if (storageKey && isBrowser) {
        window.localStorage.setItem(storageKey, payload.document.docId);
      }

      focusTitleAtEnd();
      closeMobileMenu();
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error);
    }
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
      window.addEventListener('keydown', handleGlobalKeydown);
    }
  });

  onDestroy(() => {
    if (isBrowser) {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('keydown', handleGlobalKeydown);
      if (mobileMenuHistoryActive) {
        window.removeEventListener('popstate', handleMobileMenuPopState);
      }
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

<div
  class="relative min-h-screen bg-editor-background"
  ontouchstart={handleTouchStart}
  ontouchend={handleTouchEnd}
  ontouchcancel={handleTouchCancel}
>
  <div class="mx-auto flex min-h-screen w-full max-w-5xl flex-col md:grid md:grid-cols-[300px_minmax(0,1fr)_220px]">
    <div
      class="relative hidden h-full w-[18rem] md:block"
      onpointerenter={handleSidebarPointerEnter}
      onpointerleave={handleSidebarPointerLeave}
    >
      <aside
        class="relative flex h-full flex-col bg-white/95 px-5 py-6 text-editor-text opacity-0 transition-opacity"
        class:opacity-100={sidebarVisible}
        class:shadow-xl={sidebarVisible}
        style:transition-duration={sidebarVisible ? '150ms' : '260ms'}
        bind:this={sidebarElement}
        onfocusin={handleSidebarFocusIn}
        onfocusout={handleSidebarFocusOut}
        role="navigation"
        aria-label="Document list"
      >
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-editor-busy">
          Documents
        </h2>

        <button
          type="button"
          class="mb-4 inline-flex w-full items-center justify-center rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          data-sidebar-action
          onclick={handleCreateNewDocument}
          tabindex={sidebarVisible ? 0 : -1}
        >
          New document
        </button>

        {#if indexError}
          <p class="mb-3 text-sm text-editor-error">{indexError}</p>
        {/if}

        {#if isIndexLoading && documents.length === 0}
          <p class="mb-4 text-sm text-editor-busy">Loading…</p>
        {:else if documents.length === 0}
          <p class="mb-4 text-sm text-editor-busy">No saved documents yet.</p>
        {/if}

        <nav class="flex-1" aria-label="Document titles">
          <ul class="flex-1 space-y-1 overflow-y-auto pb-2">
            {#each documents as entry (entry.docId)}
              <li>
                <button
                  type="button"
                  class="relative w-full rounded-md border-l-4 border-transparent px-3 py-2 text-left text-base transition hover:bg-editor-background focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  class:border-accent={docId === entry.docId}
                  class:font-semibold={docId === entry.docId}
                  aria-current={docId === entry.docId ? 'page' : undefined}
                  data-doc-button
                  onclick={() => handleDocumentSelect(entry.docId)}
                  tabindex={sidebarVisible ? 0 : -1}
                >
                  <span class="block truncate">{entry.title}</span>
                </button>
              </li>
            {/each}
          </ul>
        </nav>
      </aside>
    </div>

    <main class="relative flex min-h-screen flex-col px-6 pb-24 pt-16 md:px-12 md:pb-32 md:pt-20">
      <button
        type="button"
        class="absolute left-6 top-6 z-30 flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-white shadow-md transition hover:bg-editor-background focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 md:hidden"
        aria-label="Open document list"
        onclick={openMobileMenu}
      >
        <span class="flex flex-col items-center justify-center gap-1">
          <span class="h-0.5 w-5 bg-editor-text"></span>
          <span class="h-0.5 w-5 bg-editor-text"></span>
          <span class="h-0.5 w-5 bg-editor-text"></span>
        </span>
      </button>

      <section class="mx-auto flex w-full max-w-3xl flex-1 flex-col">
        <h1
          class="mb-6 w-full text-4xl font-heading leading-tight focus:outline-none"
          bind:this={titleElement}
          contenteditable="true"
          spellcheck="false"
          autocapitalize="off"
          translate="no"
          lang="en"
          aria-label="Document title"
          oninput={handleTitleInput}
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
    </main>

    <div class="hidden md:block" aria-hidden="true"></div>
  </div>

  {#if isMobileMenuOpen}
    <div
      class="fixed inset-0 z-30 flex bg-black/40 backdrop-blur-sm md:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Document list"
    >
      <div class="h-full w-72 max-w-[80%] bg-white/95 px-5 py-6 text-editor-text shadow-xl">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-sm font-semibold uppercase tracking-wide text-editor-busy">
            Documents
          </h2>
          <button
            type="button"
            class="rounded-full px-3 py-1 text-sm text-editor-text hover:bg-editor-background focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            onclick={() => closeMobileMenu()}
          >
            Close
          </button>
        </div>

        <button
          type="button"
          class="mb-4 inline-flex w-full items-center justify-center rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          onclick={handleCreateNewDocument}
        >
          New document
        </button>

        {#if indexError}
          <p class="mb-3 text-sm text-editor-error">{indexError}</p>
        {/if}

        {#if isIndexLoading && documents.length === 0}
          <p class="mb-4 text-sm text-editor-busy">Loading…</p>
        {:else if documents.length === 0}
          <p class="mb-4 text-sm text-editor-busy">No saved documents yet.</p>
        {/if}

        <nav aria-label="Document titles">
          <ul class="space-y-1 overflow-y-auto">
            {#each documents as entry (entry.docId)}
              <li>
                <button
                  type="button"
                  class="relative w-full rounded-md border-l-4 border-transparent px-3 py-2 text-left text-base transition hover:bg-editor-background focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  class:border-accent={docId === entry.docId}
                  class:font-semibold={docId === entry.docId}
                  aria-current={docId === entry.docId ? 'page' : undefined}
                  onclick={() => handleDocumentSelect(entry.docId)}
                >
                  <span class="block truncate">{entry.title}</span>
                </button>
              </li>
            {/each}
          </ul>
        </nav>
      </div>

      <button
        type="button"
        class="flex-1"
        aria-label="Close document list"
        onclick={() => closeMobileMenu()}
      ></button>
    </div>
  {/if}

  <div class="fixed right-6 top-6 z-20">
    <UserButton afterSignOutUrl="#/sign-in" />
  </div>
</div>
