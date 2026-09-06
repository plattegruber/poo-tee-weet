<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { useClerkContext } from 'svelte-clerk/client';
  import Icon from './Icon.svelte';

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
    tags?: string[];
  };

  const workerBaseUrl = import.meta.env.VITE_WORKER_BASE_URL;

  if (!workerBaseUrl) {
    throw new Error(
      'Missing VITE_WORKER_BASE_URL. Point it at your Cloudflare Worker origin.'
    );
  }

  const TOKEN_TEMPLATE = 'poo-tee-weet';
  const REALTIME_SEND_INTERVAL_MS = 350;
  const REALTIME_RECONNECT_DELAY_MS = 2000;
  const DEFAULT_TITLE = 'Welcome to poo-tee-weet';
  const DEFAULT_UNTITLED = 'Untitled';
  const LEGACY_UNTITLED = '(No title)';
  const DEFAULT_BODY = `<p>A distraction free writing tool.</p><p>So it goes.</p>`;
  const DEFAULT_MARKUP = `<h1>${DEFAULT_TITLE}</h1>${DEFAULT_BODY}`;
  const BLANK_DOCUMENT_MARKUP = '<h1></h1>';
  const MAX_TAGS_PER_DOCUMENT = 20;
  const MAX_TAG_LENGTH = 48;
  const TOAST_DURATION_MS = 5000;
  const isBrowser = typeof window !== 'undefined';

  const clerk = useClerkContext();

  let titleElement: HTMLElement | null = null;
  let editor: HTMLElement | null = null;
  let tagInputElement = $state<HTMLInputElement | null>(null);
  let searchInputElement = $state<HTMLInputElement | null>(null);
  let docId = $state<string | null>(null);
  let hasInitialized = false;

  let screen = $state<'editor' | 'pages'>('editor');
  let isReady = $state(false);
  let documentTags = $state<string[]>([]);
  let tagInputValue = $state('');
  let isAddingTag = $state(false);
  let selectedTags = $state<string[]>([]);
  let isSearching = $state(false);
  let searchQuery = $state('');
  let isDirty = $state(false);
  let saveError = $state<string | null>(null);
  let lastSavedAt = $state<string | null>(null);
  let wordCount = $state(0);
  let barHidden = $state(false);
  let focusMode = $state(false);
  let menuOpen = $state(false);
  let confirmDelete = $state(false);
  let toast = $state<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let realtimeStatus = $state<'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'>(
    'idle'
  );
  let realtimeError = $state<string | null>(null);
  let documents = $state<DocumentIndexEntry[]>([]);
  let isIndexLoading = $state(false);
  let indexError = $state<string | null>(null);
  let hasFrozenOrder = false;
  let isSwitchingDocument = false;

  const availableTags = $derived.by(() => buildTagCloud(documents));
  const filteredDocuments = $derived.by(() =>
    filterDocuments(documents, selectedTags, searchQuery)
  );
  const currentTitle = $derived.by(() => {
    const entry = documents.find((item) => item.docId === docId);
    return entry ? entry.title : DEFAULT_UNTITLED;
  });
  const statusText = $derived.by(() => {
    if (saveError) {
      return "Couldn't save. Check your connection and try again.";
    }
    if (isDirty || realtimeStatus === 'connecting') {
      return `${wordCount.toLocaleString()} ${wordCount === 1 ? 'word' : 'words'}`;
    }
    return 'Saved';
  });
  const statusTone = $derived.by(() => {
    if (saveError) return 'text-danger';
    if (isDirty || realtimeStatus === 'connecting') return 'text-text-faint';
    return 'text-success';
  });

  type RealtimeUpdatePayload = {
    title: string;
    content: string;
    tags: string[];
  };

  type RealtimeServerMessage =
    | { type: 'snapshot'; document: DocumentRecord }
    | { type: 'ack'; id?: number; document: DocumentRecord }
    | { type: 'remote-update'; document: DocumentRecord }
    | { type: 'error'; message?: string }
    | { type: 'pong'; timestamp: string };

  let realtimeSocket: WebSocket | null = null;
  let realtimeDocId: string | null = null;
  let desiredRealtimeDocId: string | null = null;
  let realtimeSendTimer: ReturnType<typeof setTimeout> | null = null;
  let realtimeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRealtimePayload: RealtimeUpdatePayload | null = null;
  const pendingAckIds = new Set<number>();
  const ackResolvers = new Map<number, (value: void) => void>();
  let clientMessageCounter = 0;

  const storageKey = $derived.by(() => {
    const userId = clerk.auth?.userId ?? clerk.user?.id ?? null;
    return userId ? `ptw-doc-${userId}` : null;
  });

  $effect(() => {
    if (selectedTags.length === 0) {
      return;
    }
    const availableKeys = new Set(availableTags.map((tag) => tag.toLowerCase()));
    const nextSelection = selectedTags.filter((tag) =>
      availableKeys.has(tag.toLowerCase())
    );
    if (nextSelection.length !== selectedTags.length) {
      selectedTags = nextSelection;
    }
  });

  // Relative under a week, then "12 Mar", then "12 Mar 2025".
  const formatDate = (iso: string) => {
    const value = new Date(iso);
    if (Number.isNaN(value.getTime())) return '';
    const now = new Date();
    const diffMs = now.getTime() - value.getTime();
    const minutes = Math.round(diffMs / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24 && value.getDate() === now.getDate()) {
      return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    }
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((startOfToday.getTime() - value.getTime()) / 86400000);
    if (days <= 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    const day = value.getDate();
    const month = value.toLocaleDateString('en', { month: 'short' });
    if (value.getFullYear() === now.getFullYear()) return `${day} ${month}`;
    return `${day} ${month} ${value.getFullYear()}`;
  };

  const isUntitled = (title: string) => {
    return title === DEFAULT_UNTITLED || title === LEGACY_UNTITLED;
  };

  const sanitizeTitleText = (value: string) => {
    return value.replace(/\s+/g, ' ').trim().slice(0, 120);
  };

  const resolveTitleText = (value: string | null | undefined) => {
    const sanitized = sanitizeTitleText(value ?? '');
    return sanitized || DEFAULT_UNTITLED;
  };

  const normalizeTagValue = (value: string | null | undefined) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.replace(/\s+/g, ' ').trim().replace(/^#+/, '');
    if (!trimmed) {
      return null;
    }
    return trimmed.slice(0, MAX_TAG_LENGTH);
  };

  const normalizeTagList = (list: string[] | null | undefined): string[] => {
    if (!Array.isArray(list)) {
      return [];
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      const sanitized = normalizeTagValue(item);
      if (!sanitized) {
        continue;
      }
      const key = sanitized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push(sanitized);
      if (normalized.length >= MAX_TAGS_PER_DOCUMENT) {
        break;
      }
    }
    return normalized;
  };

  const areTagListsEqual = (a: string[], b: string[]) => {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => value === b[index]);
  };

  const buildTagCloud = (entries: DocumentIndexEntry[]): string[] => {
    if (!entries.length) {
      return [];
    }
    const map = new Map<string, { label: string; count: number }>();
    for (const entry of entries) {
      for (const tag of entry.tags ?? []) {
        const sanitized = normalizeTagValue(tag);
        if (!sanitized) {
          continue;
        }
        const key = sanitized.toLowerCase();
        const bucket = map.get(key);
        if (bucket) {
          bucket.count += 1;
        } else {
          map.set(key, { label: sanitized, count: 1 });
        }
      }
    }
    return Array.from(map.values())
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return a.label.localeCompare(b.label);
      })
      .map((item) => item.label);
  };

  const filterDocuments = (
    entries: DocumentIndexEntry[],
    selected: string[],
    query: string
  ): DocumentIndexEntry[] => {
    const needles = selected.map((tag) => tag.toLowerCase());
    const q = query.trim().toLowerCase();
    return entries.filter((entry) => {
      const haystack = entry.tags.map((tag) => tag.toLowerCase());
      if (!needles.every((needle) => haystack.includes(needle))) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        entry.title.toLowerCase().includes(q) ||
        haystack.some((tag) => tag.includes(q))
      );
    });
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
      tags: normalizeTagList(entry.tags),
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

  const setDocumentTagsState = (value: string[] | null | undefined) => {
    const normalized = normalizeTagList(value);
    if (!areTagListsEqual(documentTags, normalized)) {
      documentTags = normalized;
    }
  };

  const upsertCurrentDocumentTags = (normalized: string[]) => {
    if (!docId) {
      return;
    }
    const target = documents.find((entry) => entry.docId === docId);
    if (target) {
      if (areTagListsEqual(target.tags, normalized)) {
        return;
      }
      updateDocumentIndexEntry({ ...target, tags: normalized });
      return;
    }
    const timestamp = new Date().toISOString();
    updateDocumentIndexEntry(
      {
        docId,
        title: resolveTitleText(titleElement?.textContent ?? DEFAULT_UNTITLED),
        tags: normalized,
        updatedAt: lastSavedAt ?? timestamp,
        createdAt: lastSavedAt ?? timestamp,
        version: 0,
      },
      { insertAtStart: true }
    );
  };

  const persistDocumentTags = (
    next: string[],
    options: { skipRealtime?: boolean } = {}
  ) => {
    const normalized = normalizeTagList(next);
    if (areTagListsEqual(documentTags, normalized)) {
      tagInputValue = '';
      return;
    }
    documentTags = normalized;
    tagInputValue = '';
    upsertCurrentDocumentTags(normalized);
    if (!options.skipRealtime) {
      isDirty = true;
      queueRealtimeUpdate({ immediate: true });
    }
  };

  const handleTagRemove = (tag: string) => {
    const key = tag.toLowerCase();
    const next = documentTags.filter((item) => item.toLowerCase() !== key);
    if (next.length === documentTags.length) {
      return;
    }
    persistDocumentTags(next);
  };

  const commitTagValue = (raw: string) => {
    const sanitized = normalizeTagValue(raw);
    if (!sanitized) {
      tagInputValue = '';
      return;
    }
    if (documentTags.some((tag) => tag.toLowerCase() === sanitized.toLowerCase())) {
      tagInputValue = '';
      return;
    }
    if (documentTags.length >= MAX_TAGS_PER_DOCUMENT) {
      tagInputValue = '';
      return;
    }
    persistDocumentTags([...documentTags, sanitized]);
  };

  const startAddingTag = () => {
    if (documentTags.length >= MAX_TAGS_PER_DOCUMENT) return;
    isAddingTag = true;
    tagInputValue = '';
    void tick().then(() => tagInputElement?.focus());
  };

  const stopAddingTag = () => {
    isAddingTag = false;
    tagInputValue = '';
  };

  const handleTagInputKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
      if (event.key === 'Tab' && !tagInputValue.trim()) {
        stopAddingTag();
        return;
      }
      event.preventDefault();
      commitTagValue(tagInputValue);
      if (event.key === 'Tab') {
        stopAddingTag();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      stopAddingTag();
      return;
    }
    if (event.key === 'Backspace' && tagInputValue.trim() === '') {
      if (documentTags.length === 0) {
        return;
      }
      event.preventDefault();
      persistDocumentTags(documentTags.slice(0, -1));
    }
  };

  const handleTagInputBlur = () => {
    if (tagInputValue.trim()) {
      commitTagValue(tagInputValue);
    }
    stopAddingTag();
  };

  const clearTagFilter = () => {
    if (selectedTags.length === 0) {
      return;
    }
    selectedTags = [];
  };

  const isTagSelected = (tag: string) => {
    const normalized = normalizeTagValue(tag);
    if (!normalized) {
      return false;
    }
    const key = normalized.toLowerCase();
    return selectedTags.some((value) => value.toLowerCase() === key);
  };

  const toggleTagSelection = (tag: string) => {
    const normalized = normalizeTagValue(tag);
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    const existingIndex = selectedTags.findIndex(
      (value) => value.toLowerCase() === key
    );
    if (existingIndex === -1) {
      selectedTags = [...selectedTags, normalized];
      return;
    }
    selectedTags = selectedTags.filter((_, index) => index !== existingIndex);
  };

  const toggleSearch = () => {
    isSearching = !isSearching;
    if (!isSearching) {
      searchQuery = '';
      return;
    }
    void tick().then(() => searchInputElement?.focus());
  };

  const ALLOWED_TAGS = new Set([
    'P', 'BR', 'DIV', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
  ]);
  const DROP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'LINK', 'META', 'TEMPLATE',
  ]);

  // Keep only structural and inline-emphasis tags, no attributes. Anything else is
  // unwrapped to its text so pasted or legacy markup cannot carry styles or scripts.
  const sanitizeHtml = (html: string) => {
    if (typeof document === 'undefined') return html;
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const walk = (node: Node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) continue;
        if (child.nodeType !== Node.ELEMENT_NODE) {
          child.remove();
          continue;
        }
        const element = child as HTMLElement;
        if (DROP_TAGS.has(element.tagName)) {
          element.remove();
          continue;
        }
        walk(element);
        if (!ALLOWED_TAGS.has(element.tagName)) {
          element.replaceWith(...Array.from(element.childNodes));
          continue;
        }
        for (const attr of Array.from(element.attributes)) {
          element.removeAttribute(attr.name);
        }
      }
    };
    walk(temp);
    return temp.innerHTML;
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

  const countWords = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  };

  const updateWordCount = () => {
    wordCount = countWords(editor?.innerText ?? '');
  };

  const hasVisibleText = (html: string) => {
    if (typeof document === 'undefined') return html.trim().length > 0;
    const temp = document.createElement('div');
    temp.innerHTML = html;
    return (temp.textContent ?? '').trim().length > 0;
  };

  const applyDocumentContent = (titleText: string, bodyHtml: string) => {
    if (titleElement) {
      titleElement.textContent = isUntitled(titleText) ? '' : titleText;
    }

    if (editor) {
      const clean = sanitizeHtml(bodyHtml ?? '');
      editor.innerHTML = hasVisibleText(clean) ? clean : '';
    }
    updateWordCount();
  };

  const serializeDocument = () => {
    const titleTextRaw = titleElement?.textContent ?? '';
    const titleText = resolveTitleText(titleTextRaw);
    const bodyHtml = sanitizeHtml(editor?.innerHTML ?? '');
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
    if (event.key === 'Enter') {
      event.preventDefault();
      focusEditorAtStart();
      return;
    }
    if (event.key !== 'ArrowDown' || event.shiftKey) {
      return;
    }
    if (!editor) return;
    event.preventDefault();
    focusEditorAtStart();
  };

  const handlePaste = (event: ClipboardEvent) => {
    event.preventDefault();
    let text = event.clipboardData?.getData('text/plain') ?? '';
    if (event.currentTarget === titleElement) {
      text = text.replace(/\s+/g, ' ');
    }
    if (text) {
      document.execCommand('insertText', false, text);
    }
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

  const resolveRealtimeUrl = (targetDocId: string, token: string) => {
    const base = new URL(workerBaseUrl);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = `/docs/${targetDocId}/sync`;
    base.search = '';
    base.searchParams.set('auth', token);
    return base.toString();
  };

  const captureRealtimePayload = (): RealtimeUpdatePayload | null => {
    if (!docId) return null;
    const title = resolveTitleText(titleElement?.textContent ?? '');
    const content = serializeDocument();
    return { title, content, tags: [...documentTags] };
  };

  const sendPendingRealtimePayload = (
    trackAck = false
  ): { id: number; promise: Promise<void> } | null => {
    if (!pendingRealtimePayload) return null;
    if (!realtimeSocket || realtimeSocket.readyState !== WebSocket.OPEN) {
      return null;
    }

    const payload = pendingRealtimePayload;
    pendingRealtimePayload = null;
    const messageId = ++clientMessageCounter;
    const message = {
      type: 'update',
      id: messageId,
      title: payload.title,
      content: payload.content,
      tags: payload.tags,
    };

    try {
      realtimeSocket.send(JSON.stringify(message));
      pendingAckIds.add(messageId);
    } catch (error) {
      pendingRealtimePayload = payload;
      realtimeStatus = 'error';
      realtimeError = error instanceof Error ? error.message : String(error);
      saveError = realtimeError;
      return null;
    }

    if (!trackAck) {
      return null;
    }

    const promise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ackResolvers.delete(messageId);
        reject(new Error('Timed out waiting for realtime acknowledgement'));
      }, 5000);
      ackResolvers.set(messageId, () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    return { id: messageId, promise };
  };

  const queueRealtimeUpdate = (options: { immediate?: boolean } = {}) => {
    if (!isBrowser) return;
    const payload = captureRealtimePayload();
    if (!payload) return;
    pendingRealtimePayload = payload;
    isDirty = true;

    if (!realtimeSocket || realtimeSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (options.immediate) {
      sendPendingRealtimePayload();
      return;
    }

    if (realtimeSendTimer) {
      return;
    }

    realtimeSendTimer = setTimeout(() => {
      realtimeSendTimer = null;
      sendPendingRealtimePayload();
    }, REALTIME_SEND_INTERVAL_MS);
  };

  const flushRealtimeUpdates = async () => {
    if (!isBrowser) return;
    if (realtimeSendTimer) {
      clearTimeout(realtimeSendTimer);
      realtimeSendTimer = null;
    }

    if (!pendingRealtimePayload) {
      const payload = captureRealtimePayload();
      if (payload) {
        pendingRealtimePayload = payload;
      }
    }

    const tracked = sendPendingRealtimePayload(true);
    if (tracked) {
      try {
        await tracked.promise;
      } catch (error) {
        saveError = error instanceof Error ? error.message : String(error);
      }
    }
  };

  const applyDocumentMetadata = (record: DocumentRecord, allowDomUpdate: boolean) => {
    if (!docId || record.docId !== docId) {
      return;
    }

    lastSavedAt = record.updatedAt;
    setDocumentTagsState(record.tags);
    updateDocumentIndexEntry(toDocumentMetadata(record));

    if (!allowDomUpdate) {
      return;
    }

    if (isDirty || pendingRealtimePayload || pendingAckIds.size > 0) {
      return;
    }

    const { titleText, bodyHtml } = splitDocumentContent(
      record.content || DEFAULT_MARKUP
    );
    applyDocumentContent(titleText, bodyHtml);
    updateCurrentDocumentTitle(titleText);
  };

  const handleRealtimeAck = (payload: { id?: number; document: DocumentRecord }) => {
    if (typeof payload.id === 'number') {
      pendingAckIds.delete(payload.id);
      const resolver = ackResolvers.get(payload.id);
      if (resolver) {
        ackResolvers.delete(payload.id);
        resolver();
      }
    }

    applyDocumentMetadata(payload.document, false);
    isDirty = pendingAckIds.size > 0 || !!pendingRealtimePayload;
    saveError = null;
  };

  const handleRealtimeMessage = (event: MessageEvent) => {
    if (event.target !== realtimeSocket) {
      return;
    }

    let payload: RealtimeServerMessage | null = null;
    try {
      if (typeof event.data !== 'string') {
        return;
      }
      payload = JSON.parse(event.data) as RealtimeServerMessage;
    } catch {
      return;
    }

    if (!payload) {
      return;
    }

    switch (payload.type) {
      case 'snapshot':
        applyDocumentMetadata(payload.document, true);
        break;
      case 'ack':
        handleRealtimeAck(payload);
        break;
      case 'remote-update':
        applyDocumentMetadata(payload.document, true);
        break;
      case 'error':
        realtimeStatus = 'error';
        realtimeError = payload.message ?? 'Realtime sync error';
        saveError = realtimeError;
        break;
      default:
        break;
    }
  };

  const handleRealtimeOpen = (event: Event) => {
    if (event.target !== realtimeSocket) {
      return;
    }
    realtimeStatus = 'connected';
    realtimeError = null;
    saveError = null;
    if (pendingRealtimePayload) {
      sendPendingRealtimePayload();
    }
  };

  const handleRealtimeClose = (event: CloseEvent) => {
    const closedDocId = realtimeDocId;
    if (event.target !== realtimeSocket) {
      return;
    }

    realtimeSocket = null;
    realtimeDocId = null;
    realtimeStatus = 'disconnected';
    pendingAckIds.clear();

    if (event.code === 4410) {
      desiredRealtimeDocId = null;
      return;
    }

    if (pendingAckIds.size > 0 || pendingRealtimePayload) {
      isDirty = true;
    }

    if (!pendingRealtimePayload) {
      const payload = captureRealtimePayload();
      if (payload) {
        pendingRealtimePayload = payload;
        isDirty = true;
      }
    }

    if (desiredRealtimeDocId && desiredRealtimeDocId === closedDocId) {
      scheduleRealtimeReconnect(closedDocId);
    }
  };

  const handleRealtimeError = (event: Event) => {
    if (event.target !== realtimeSocket) {
      return;
    }
    realtimeStatus = 'error';
    realtimeError = 'Realtime connection error';
    saveError = realtimeError;
  };

  const detachRealtimeListeners = (socket: WebSocket) => {
    socket.removeEventListener('open', handleRealtimeOpen);
    socket.removeEventListener('message', handleRealtimeMessage);
    socket.removeEventListener('error', handleRealtimeError);
    socket.removeEventListener('close', handleRealtimeClose);
  };

  const attachRealtimeListeners = (socket: WebSocket) => {
    socket.addEventListener('open', handleRealtimeOpen);
    socket.addEventListener('message', handleRealtimeMessage);
    socket.addEventListener('error', handleRealtimeError);
    socket.addEventListener('close', handleRealtimeClose);
  };

  const scheduleRealtimeReconnect = (docToReconnect: string | null) => {
    if (!docToReconnect) return;
    if (realtimeReconnectTimer) return;
    realtimeReconnectTimer = setTimeout(() => {
      realtimeReconnectTimer = null;
      if (desiredRealtimeDocId === docToReconnect) {
        void establishRealtimeConnection(docToReconnect);
      }
    }, REALTIME_RECONNECT_DELAY_MS);
  };

  const teardownRealtimeConnection = (resetTarget = false) => {
    if (realtimeReconnectTimer) {
      clearTimeout(realtimeReconnectTimer);
      realtimeReconnectTimer = null;
    }

    if (realtimeSocket) {
      detachRealtimeListeners(realtimeSocket);
      realtimeSocket.close();
      realtimeSocket = null;
    }

    if (resetTarget) {
      desiredRealtimeDocId = null;
      realtimeDocId = null;
      realtimeStatus = 'idle';
    }
  };

  const establishRealtimeConnection = async (targetDocId: string) => {
    if (!isBrowser) return;
    if (!targetDocId) return;

    desiredRealtimeDocId = targetDocId;
    teardownRealtimeConnection();
    realtimeStatus = 'connecting';

    try {
      const token = await getSessionToken();
      const url = resolveRealtimeUrl(targetDocId, token);
      const socket = new WebSocket(url);
      realtimeSocket = socket;
      realtimeDocId = targetDocId;
      attachRealtimeListeners(socket);
    } catch (error) {
      realtimeStatus = 'error';
      realtimeError = error instanceof Error ? error.message : String(error);
      saveError = realtimeError;
    }
  };

  const ensureRealtimeSession = async () => {
    if (!isBrowser) return;
    if (!docId) return;
    if (
      realtimeSocket &&
      realtimeDocId === docId &&
      realtimeSocket.readyState === WebSocket.OPEN
    ) {
      desiredRealtimeDocId = docId;
      return;
    }
    await establishRealtimeConnection(docId);
  };

  const fetchDocumentIndex = async (): Promise<DocumentIndexEntry[] | null> => {
    isIndexLoading = true;
    indexError = null;

    try {
      const response = await apiRequest('/me/docs', { method: 'GET' });
      if (!response.ok) {
        const message = await response.text();
        indexError = message || `Couldn't load your pages (${response.status}).`;
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
      saveError = `Couldn't open the page (${response.status}).`;
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
    setDocumentTagsState(payload.document.tags);
    tagInputValue = '';
    isAddingTag = false;

    const { titleText, bodyHtml } = splitDocumentContent(
      payload.document.content || DEFAULT_MARKUP
    );

    applyDocumentContent(titleText, bodyHtml);

    return true;
  };

  const createDocument = async (key: string) => {
    const { titleText, bodyHtml } = splitDocumentContent(DEFAULT_MARKUP);
    applyDocumentContent(titleText, bodyHtml);

    const response = await apiRequest('/me/docs', {
      method: 'POST',
      body: JSON.stringify({
        title: titleText,
        content: serializeDocument(),
        tags: [],
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        message ? `Couldn't create a page: ${message}` : "Couldn't create a page."
      );
    }

    const payload = (await response.json()) as DocumentResponse;
    docId = payload.document.docId;
    lastSavedAt = payload.document.updatedAt;
    saveError = null;
    isDirty = false;
    updateDocumentIndexEntry(toDocumentMetadata(payload.document));
    setDocumentTagsState(payload.document.tags);
    tagInputValue = '';

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
    }

    if (docId) {
      pendingRealtimePayload = null;
      pendingAckIds.clear();
      desiredRealtimeDocId = docId;
      await ensureRealtimeSession();
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
        tags: documentTags,
      }, { insertAtStart: true });
    }
  };

  const clearIfBlank = (element: HTMLElement | null) => {
    if (!element) return;
    if (element.childNodes.length > 0 && !(element.textContent ?? '').trim()) {
      element.innerHTML = '';
    }
  };

  const hideBarWhileTyping = () => {
    barHidden = true;
    menuOpen = false;
  };

  const handleTitleInput = () => {
    clearIfBlank(titleElement);
    const raw = titleElement?.textContent ?? '';
    updateCurrentDocumentTitle(raw);
    isDirty = true;
    hideBarWhileTyping();
    queueRealtimeUpdate();
  };

  const handleInput = () => {
    clearIfBlank(editor);
    updateWordCount();
    isDirty = true;
    hideBarWhileTyping();
    queueRealtimeUpdate();
  };

  // Blur flushes unsent edits; an untouched page is never re-sent, so its
  // "last edited" time only moves when something actually changed.
  const flushIfDirty = () => {
    if (isDirty || pendingRealtimePayload) {
      queueRealtimeUpdate({ immediate: true });
    }
  };

  const handleBlur = () => {
    flushIfDirty();
  };

  const handleTitleBlur = () => {
    clearIfBlank(titleElement);
    updateCurrentDocumentTitle(titleElement?.textContent ?? DEFAULT_UNTITLED);
    flushIfDirty();
  };

  const handleMouseMove = () => {
    if (barHidden) {
      barHidden = false;
    }
  };

  const showToast = (message: string) => {
    if (toastTimer) clearTimeout(toastTimer);
    toast = message;
    toastTimer = setTimeout(() => {
      toast = null;
      toastTimer = null;
    }, TOAST_DURATION_MS);
  };

  const showPages = () => {
    menuOpen = false;
    confirmDelete = false;
    barHidden = false;
    screen = 'pages';
    flushIfDirty();
  };

  const showEditor = () => {
    isSearching = false;
    searchQuery = '';
    barHidden = false;
    screen = 'editor';
  };

  const handleDocumentSelect = async (candidateId: string) => {
    if (!candidateId || isSwitchingDocument) return;
    if (candidateId === docId) {
      showEditor();
      return;
    }

    isSwitchingDocument = true;
    try {
      const previousDocId = docId;
      desiredRealtimeDocId = candidateId;
      await flushRealtimeUpdates();
      teardownRealtimeConnection();

      const loaded = await loadExistingDocument(candidateId);
      if (loaded) {
        if (storageKey && isBrowser) {
          window.localStorage.setItem(storageKey, candidateId);
        }
        pendingRealtimePayload = null;
        pendingAckIds.clear();
        await ensureRealtimeSession();
        showEditor();
      } else if (previousDocId) {
        desiredRealtimeDocId = previousDocId;
        await ensureRealtimeSession();
      }
    } finally {
      isSwitchingDocument = false;
    }
  };

  const handleCreateNewDocument = async () => {
    if (!storageKey || isSwitchingDocument) return;

    isSwitchingDocument = true;
    await flushRealtimeUpdates();

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
          message ? `Couldn't create a page: ${message}` : "Couldn't create a page."
        );
      }

      const payload = (await response.json()) as DocumentResponse;
      docId = payload.document.docId;
      lastSavedAt = payload.document.updatedAt;
      saveError = null;
      isDirty = false;
      pendingRealtimePayload = null;
      pendingAckIds.clear();
      updateDocumentIndexEntry(toDocumentMetadata(payload.document), {
        insertAtStart: true,
      });
      setDocumentTagsState(payload.document.tags);
      tagInputValue = '';
      isAddingTag = false;

      const { titleText, bodyHtml } = splitDocumentContent(
        payload.document.content || BLANK_DOCUMENT_MARKUP
      );

      applyDocumentContent(titleText, bodyHtml);
      updateCurrentDocumentTitle(titleText);

      if (storageKey && isBrowser) {
        window.localStorage.setItem(storageKey, payload.document.docId);
      }

      await ensureRealtimeSession();
      showEditor();
      if (isBrowser) {
        window.requestAnimationFrame(() => focusTitleAtEnd());
      }
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error);
    } finally {
      isSwitchingDocument = false;
    }
  };

  const handleDeleteDocument = async () => {
    if (!docId || isSwitchingDocument) return;
    confirmDelete = false;
    menuOpen = false;

    const target = docId;
    teardownRealtimeConnection(true);
    pendingRealtimePayload = null;
    pendingAckIds.clear();

    try {
      const response = await apiRequest(`/docs/${target}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Couldn't delete the page (${response.status}).`);
      }
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error);
      desiredRealtimeDocId = target;
      await ensureRealtimeSession();
      return;
    }

    docId = null;
    isDirty = false;
    saveError = null;
    documents = documents.filter((entry) => entry.docId !== target);
    if (storageKey && isBrowser) {
      window.localStorage.removeItem(storageKey);
    }

    const next = documents[0];
    if (next && (await loadExistingDocument(next.docId))) {
      if (storageKey && isBrowser) {
        window.localStorage.setItem(storageKey, next.docId);
      }
      await ensureRealtimeSession();
      showPages();
      showToast('Page deleted.');
      return;
    }
    await handleCreateNewDocument();
    showToast('Page deleted.');
  };

  const handleExportText = () => {
    menuOpen = false;
    if (!isBrowser) return;
    const title = resolveTitleText(titleElement?.textContent ?? '');
    const body = (editor?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
    const text = `${title}\n\n${body}\n`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'page'}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const handleSignOut = async () => {
    await flushRealtimeUpdates();
    teardownRealtimeConnection(true);
    if (isBrowser) {
      window.location.hash = '#/sign-in';
    }
    await clerk.clerk?.signOut();
  };

  const handleGlobalKeydown = (event: KeyboardEvent) => {
    const key = event.key ? event.key.toLowerCase() : '';

    if ((event.metaKey || event.ctrlKey) && key === 'o') {
      event.preventDefault();
      if (screen === 'editor') {
        showPages();
      } else {
        showEditor();
      }
      return;
    }

    if (key === 'escape') {
      if (confirmDelete) {
        confirmDelete = false;
        return;
      }
      if (menuOpen) {
        menuOpen = false;
        return;
      }
      if (screen === 'pages' && isSearching) {
        toggleSearch();
        return;
      }
      if (screen === 'editor' && barHidden) {
        barHidden = false;
      }
    }
  };

  const handleGlobalPointerDown = (event: PointerEvent) => {
    if (!menuOpen) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-menu]')) return;
    menuOpen = false;
  };

  const handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!isDirty) return;
    event.preventDefault();
    event.returnValue = '';
  };

  onMount(() => {
    if (isBrowser) {
      window.addEventListener('beforeunload', handleBeforeUnload);
      window.addEventListener('keydown', handleGlobalKeydown);
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('pointerdown', handleGlobalPointerDown);
    }
  });

  onDestroy(() => {
    if (isBrowser) {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('keydown', handleGlobalKeydown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('pointerdown', handleGlobalPointerDown);
    }
    if (toastTimer) clearTimeout(toastTimer);
    void flushRealtimeUpdates();
    teardownRealtimeConnection(true);
  });

  $effect(() => {
    if (!hasInitialized && clerk.isLoaded && clerk.session && editor) {
      hasInitialized = true;
      void initializeDocument()
        .catch((error) => {
          saveError = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          isReady = true;
          if (isBrowser) {
            window.requestAnimationFrame(() => {
              if (screen === 'editor') {
                (titleElement?.textContent ? editor : titleElement)?.focus();
              }
            });
          }
        });
    }
  });

  const iconButtonClass =
    'inline-flex h-control-md w-control-md cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-text-muted transition-colors duration-fast ease-out hover:bg-surface-sunken hover:text-text-body active:bg-surface-sunken disabled:cursor-default disabled:opacity-45';
  const tagClass =
    'inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-sm border px-2 font-mono text-sm transition-colors duration-fast ease-out';
  const menuItemClass =
    'block w-full cursor-pointer rounded-sm border-0 bg-transparent px-[10px] py-2 text-left font-ui text-md transition-colors duration-fast ease-out';
</script>

{#snippet tooltip(label: string)}
  <span
    role="tooltip"
    class="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-50 -translate-x-1/2 whitespace-nowrap rounded-sm bg-surface-inverse px-2 py-1 font-ui text-xs text-text-inverse opacity-0 transition-opacity duration-fast ease-out group-hover:opacity-100 group-focus-visible:opacity-100"
  >
    {label}
  </span>
{/snippet}

<div class="relative min-h-screen bg-surface-page" role="presentation">
  <!-- Writing page -->
  <div class:hidden={screen !== 'editor'}>
    <header
      class="fixed inset-x-0 top-0 z-10 flex h-bar items-center gap-2 px-5 transition-opacity duration-slow ease-out"
      class:opacity-0={barHidden}
      class:pointer-events-none={barHidden}
      aria-hidden={barHidden}
    >
      <div class="flex flex-1 items-center gap-2">
        <span class="group relative inline-flex">
          <button
            type="button"
            class={iconButtonClass}
            aria-label="All pages"
            onclick={showPages}
            tabindex={barHidden ? -1 : 0}
          >
            <Icon name="arrow-left" size={18} />
          </button>
          {@render tooltip('All pages')}
        </span>
      </div>

      <div
        class={`font-mono text-xs transition-colors duration-base ease-out ${statusTone}`}
        role="status"
        aria-live="polite"
      >
        {statusText}
      </div>

      <div class="relative flex flex-1 items-center justify-end gap-2" data-menu>
        <span class="group relative inline-flex">
          <button
            type="button"
            class={iconButtonClass}
            class:bg-surface-sunken={menuOpen}
            class:text-text-body={menuOpen}
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onclick={() => (menuOpen = !menuOpen)}
            tabindex={barHidden ? -1 : 0}
          >
            <Icon name="more-horizontal" size={18} />
          </button>
          {#if !menuOpen}
            {@render tooltip('More')}
          {/if}
        </span>

        {#if menuOpen}
          <div
            class="fade-in absolute right-0 top-10 z-20 grid w-[220px] gap-0.5 rounded-md border border-border-subtle bg-surface-page p-1.5 font-ui text-md shadow-lg"
            role="menu"
            aria-label="Page menu"
          >
            <div
              class="flex items-center gap-[10px] rounded-sm px-[10px] py-2 text-text-body transition-colors duration-fast ease-out hover:bg-surface-sunken"
            >
              <span
                role="switch"
                aria-checked={focusMode}
                tabindex="0"
                class="relative inline-block h-[18px] w-8 flex-none cursor-pointer rounded-pill transition-colors duration-fast ease-out"
                aria-label="Focus mode"
                class:bg-accent={focusMode}
                class:bg-border-strong={!focusMode}
                onclick={() => (focusMode = !focusMode)}
                onkeydown={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault();
                    focusMode = !focusMode;
                  }
                }}
              >
                <span
                  class="absolute top-0.5 h-[14px] w-[14px] rounded-full bg-paper-0 transition-[left] duration-fast ease-out"
                  class:left-4={focusMode}
                  class:left-0.5={!focusMode}
                ></span>
              </span>
              <span>Focus mode</span>
            </div>
            <button
              type="button"
              class={`${menuItemClass} text-text-body hover:bg-surface-sunken`}
              role="menuitem"
              onclick={handleExportText}
            >
              Export as text
            </button>
            <button
              type="button"
              class={`${menuItemClass} text-danger hover:bg-danger-soft`}
              role="menuitem"
              onclick={() => {
                menuOpen = false;
                confirmDelete = true;
              }}
            >
              Delete page
            </button>
          </div>
        {/if}
      </div>
    </header>

    <main
      class="mx-auto max-w-prose px-6 pb-[40vh] pt-[120px] transition-opacity duration-base ease-out"
      class:opacity-0={!isReady}
    >
      <h1
        class="block w-full font-display text-2xl font-regular leading-tight tracking-tight text-text-body outline-none focus:outline-none focus-visible:shadow-none"
        bind:this={titleElement}
        contenteditable="true"
        spellcheck="false"
        autocapitalize="off"
        translate="no"
        lang="en"
        aria-label="Title"
        data-placeholder="title"
        oninput={handleTitleInput}
        onblur={handleTitleBlur}
        onkeydown={handleTitleKeydown}
        onpaste={handlePaste}
        data-testid="editor-title"
      ></h1>

      <div
        class="mt-4 flex flex-wrap items-center gap-1.5 transition-opacity duration-slow ease-out"
        class:opacity-0={focusMode && barHidden}
        aria-label="Tags"
      >
        {#each documentTags as tag (tag)}
          <span class={`${tagClass} border-border-subtle text-text-body`}>
            <span class="opacity-60">#</span>{tag}
            <button
              type="button"
              class="ml-0.5 inline-flex cursor-pointer items-center border-0 bg-transparent p-0 text-current opacity-70 transition-opacity duration-fast ease-out hover:opacity-100"
              aria-label={`Remove ${tag}`}
              onclick={() => handleTagRemove(tag)}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        {/each}

        {#if isAddingTag}
          <input
            type="text"
            class="h-6 w-[110px] rounded-sm border border-border-focus bg-transparent px-2 font-mono text-sm text-text-body outline-none placeholder:text-text-faint focus-visible:shadow-none"
            placeholder="add a tag"
            bind:this={tagInputElement}
            bind:value={tagInputValue}
            onkeydown={handleTagInputKeydown}
            onblur={handleTagInputBlur}
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            aria-label="New tag"
          />
        {:else if documentTags.length < MAX_TAGS_PER_DOCUMENT}
          <button
            type="button"
            class="inline-flex h-6 cursor-pointer items-center gap-1 border-0 bg-transparent px-1.5 font-mono text-sm text-text-faint transition-colors duration-fast ease-out hover:text-text-body"
            onclick={startAddingTag}
          >
            <Icon name="plus" size={12} />
            {documentTags.length === 0 ? 'add a tag' : ''}
          </button>
        {/if}
      </div>

      <div
        class="prose-surface tab-size-4 mt-10 block w-full min-h-[50vh] outline-none focus:outline-none focus-visible:shadow-none"
        bind:this={editor}
        contenteditable="true"
        spellcheck="false"
        autocapitalize="off"
        translate="no"
        lang="en"
        aria-label="Body"
        role="textbox"
        aria-multiline="true"
        tabindex="0"
        data-placeholder="Start writing."
        oninput={handleInput}
        onblur={handleBlur}
        onkeydown={handleEditorKeydown}
        onpaste={handlePaste}
        data-testid="editor-body"
      ></div>
    </main>
  </div>

  <!-- Pages list -->
  {#if screen === 'pages'}
    <header class="fixed inset-x-0 top-0 z-10 flex h-bar items-center gap-2 bg-surface-page px-5">
      <div class="flex flex-1 items-center gap-2">
        <span class="group relative inline-flex">
          <button
            type="button"
            class={iconButtonClass}
            aria-label="Sign out"
            onclick={handleSignOut}
          >
            <Icon name="log-out" size={18} />
          </button>
          {@render tooltip('Sign out')}
        </span>
      </div>

      <div class="font-display text-[16px] tracking-[-0.01em] text-text-muted max-sm:hidden">
        poo-tee-weet
      </div>

      <div class="flex flex-1 items-center justify-end gap-2">
        <span class="group relative inline-flex">
          <button
            type="button"
            class={iconButtonClass}
            class:bg-surface-sunken={isSearching}
            class:text-text-body={isSearching}
            aria-label="Search"
            aria-pressed={isSearching}
            onclick={toggleSearch}
          >
            <Icon name="search" size={18} />
          </button>
          {@render tooltip('Search tags')}
        </span>
        <button
          type="button"
          class="inline-flex h-control-sm cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-border-strong bg-transparent px-[10px] font-ui text-sm font-medium leading-none text-text-body transition-colors duration-fast ease-out hover:bg-surface-sunken"
          onclick={handleCreateNewDocument}
        >
          <Icon name="plus" size={14} />
          New page
        </button>
      </div>
    </header>

    <main class="mx-auto max-w-list px-6 py-24">
      <h1 class="font-display text-2xl font-regular leading-tight tracking-tight text-text-body">
        Your pages
      </h1>

      {#if availableTags.length > 0}
        <div class="mt-6 flex flex-wrap items-center gap-2" aria-label="Filter by tag">
          {#each availableTags as tag (tag.toLowerCase())}
            <button
              type="button"
              class={`${tagClass} cursor-pointer ${
                isTagSelected(tag)
                  ? 'border-accent bg-accent text-accent-on'
                  : 'border-border-subtle bg-transparent text-text-muted hover:bg-surface-sunken hover:text-text-body'
              }`}
              aria-pressed={isTagSelected(tag)}
              onclick={() => toggleTagSelection(tag)}
            >
              <span class="opacity-60">#</span>{tag}
            </button>
          {/each}
          {#if selectedTags.length > 0}
            <button
              type="button"
              class="ml-1 cursor-pointer border-0 bg-transparent p-0 font-ui text-sm text-text-muted transition-colors duration-fast ease-out hover:text-text-body"
              onclick={clearTagFilter}
            >
              Clear
            </button>
          {/if}
        </div>
      {/if}

      {#if isSearching}
        <label class="mt-6 flex flex-col gap-1.5 font-ui">
          <span class="sr-only">Search</span>
          <input
            type="text"
            class="h-control-md w-full rounded-sm border border-border-subtle bg-surface-raised px-3 font-ui text-md leading-normal text-text-body outline-none transition-[border-color,box-shadow] duration-fast ease-out placeholder:text-text-faint focus:border-border-focus focus:shadow-focus"
            placeholder="search tags or titles"
            bind:this={searchInputElement}
            bind:value={searchQuery}
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
        </label>
      {/if}

      {#if indexError}
        <p class="mt-6 font-ui text-md text-danger">{indexError}</p>
      {/if}

      <div class="mt-8 border-t border-border-subtle">
        {#if isIndexLoading && documents.length === 0}
          <p class="py-8 font-ui text-md text-text-muted">Loading…</p>
        {:else if filteredDocuments.length === 0}
          <p class="py-8 font-ui text-md text-text-muted">
            {#if documents.length === 0}
              Nothing here yet. Start writing.
            {:else if selectedTags.length > 0}
              No pages tagged <em>{selectedTags.join(', ')}</em>.
            {:else}
              No pages match “{searchQuery.trim()}”.
            {/if}
          </p>
        {:else}
          <ul class="m-0 list-none p-0" aria-label="Pages">
            {#each filteredDocuments as entry (entry.docId)}
              <li>
                <button
                  type="button"
                  class="group flex w-full cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 border-0 border-b border-solid border-border-subtle bg-transparent px-0 py-4 text-left sm:flex-nowrap"
                  aria-current={docId === entry.docId ? 'page' : undefined}
                  data-doc-button
                  onclick={() => handleDocumentSelect(entry.docId)}
                >
                  <span
                    class="min-w-0 basis-full truncate font-display text-lg text-text-body transition-colors duration-fast ease-out group-hover:text-text-accent sm:basis-auto sm:flex-auto"
                    class:italic={isUntitled(entry.title)}
                  >
                    {isUntitled(entry.title) ? DEFAULT_UNTITLED : entry.title}
                  </span>
                  {#if entry.tags.length > 0}
                    <span class="flex flex-none flex-wrap gap-2 font-mono text-sm text-text-muted">
                      {#each entry.tags as tag (tag)}
                        <span>#{tag}</span>
                      {/each}
                    </span>
                  {/if}
                  <span class="ml-auto min-w-[80px] flex-none text-right font-ui text-sm text-text-faint sm:ml-0">
                    {formatDate(entry.updatedAt)}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </main>
  {/if}

  <!-- Delete confirmation -->
  {#if confirmDelete}
    <div
      class="fade-in fixed inset-0 z-[100] flex items-center justify-center bg-scrim p-6"
      role="presentation"
      onclick={(event) => {
        if (event.target === event.currentTarget) confirmDelete = false;
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        class="w-full max-w-dialog rounded-lg border border-border-subtle bg-surface-page p-6 font-ui shadow-lg"
      >
        <h2
          id="delete-title"
          class="m-0 font-display text-xl font-regular leading-snug text-text-body"
        >
          Delete ‘{isUntitled(currentTitle) ? DEFAULT_UNTITLED : currentTitle}’?
        </h2>
        <p class="mb-0 mt-2 text-md leading-normal text-text-muted">This can't be undone.</p>
        <div class="mt-6 flex justify-end gap-2">
          <button
            type="button"
            class="inline-flex h-control-md cursor-pointer items-center justify-center rounded-md border border-transparent bg-transparent px-[14px] font-ui text-md font-medium leading-none text-text-muted transition-colors duration-fast ease-out hover:bg-surface-sunken hover:text-text-body"
            onclick={() => (confirmDelete = false)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="inline-flex h-control-md cursor-pointer items-center justify-center rounded-md border border-border-strong bg-transparent px-[14px] font-ui text-md font-medium leading-none text-danger transition-colors duration-fast ease-out hover:border-danger hover:bg-danger-soft"
            onclick={handleDeleteDocument}
          >
            Delete page
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Toast -->
  {#if toast}
    <div class="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-6">
      <div
        class="fade-in rounded-md bg-surface-inverse px-4 py-2.5 font-ui text-md text-text-inverse shadow-lg"
        role="status"
        aria-live="polite"
      >
        {toast}
      </div>
    </div>
  {/if}
</div>
