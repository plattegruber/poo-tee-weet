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
  const DEFAULT_UNTITLED = '(No title)';
  const DEFAULT_BODY = `<p>A distraction free writing tool.</p><p>So it goes.</p>`;
  const DEFAULT_MARKUP = `<h1>${DEFAULT_TITLE}</h1>${DEFAULT_BODY}`;
  const BLANK_DOCUMENT_MARKUP = '<h1></h1><p><br /></p>';
  const MAX_TAGS_PER_DOCUMENT = 20;
  const MAX_TAG_LENGTH = 48;
  const SIDEBAR_HIDE_DELAY_MS = 180;
  const TOUCH_EDGE_THRESHOLD_PX = 32;
  const TOUCH_OPEN_DISTANCE_PX = 48;
  const isBrowser = typeof window !== 'undefined';

  const clerk = useClerkContext();

  let titleElement: HTMLElement | null = null;
  let editor: HTMLElement | null = null;
  let docId = $state<string | null>(null);
  let hasInitialized = false;

  let documentTags = $state<string[]>([]);
  let tagInputValue = $state('');
  let selectedTags = $state<string[]>([]);
  let isDirty = $state(false);
  let saveError = $state<string | null>(null);
  let lastSavedAt = $state<string | null>(null);
  let realtimeStatus = $state<'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'>(
    'idle'
  );
  let realtimeError = $state<string | null>(null);
  const realtimeStatusLabel = $derived.by(() => {
    switch (realtimeStatus) {
      case 'connected':
        return 'Connected to autosave service';
      case 'connecting':
        return 'Connecting to autosave service';
      case 'error':
        return 'Autosave connection error';
      case 'disconnected':
        return 'Autosave is offline';
      default:
        return 'Autosave idle';
    }
  });
  const REALTIME_STATUS_STYLES: Record<
    'idle' | 'connecting' | 'connected' | 'disconnected' | 'error',
    string
  > = {
    idle: 'bg-gray-300 text-white',
    connecting: 'bg-amber-400 text-white',
    connected: 'bg-emerald-500 text-white',
    disconnected: 'bg-gray-400 text-white',
    error: 'bg-red-500 text-white',
  };
  const realtimeIndicatorClass = $derived.by(() => {
    return REALTIME_STATUS_STYLES[realtimeStatus] ?? REALTIME_STATUS_STYLES.idle;
  });
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

  const availableTags = $derived.by(() => buildTagCloud(documents));
  const filteredDocuments = $derived.by(() =>
    filterDocumentsByTags(documents, selectedTags)
  );

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
    const sessionId = clerk.session?.id ?? null;
    return sessionId ? `ptw-doc-${sessionId}` : null;
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

  const normalizeTagValue = (value: string | null | undefined) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.replace(/\s+/g, ' ').trim();
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

  const filterDocumentsByTags = (
    entries: DocumentIndexEntry[],
    selected: string[]
  ): DocumentIndexEntry[] => {
    if (!selected.length) {
      return entries;
    }
    const needles = selected.map((tag) => tag.toLowerCase());
    return entries.filter((entry) => {
      const haystack = entry.tags.map((tag) => tag.toLowerCase());
      return needles.every((needle) => haystack.includes(needle));
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
    documentTags = normalized;
    tagInputValue = '';
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

  const handleTagInputKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commitTagValue(tagInputValue);
      return;
    }
    if (event.key === 'Tab') {
      if (tagInputValue.trim()) {
        event.preventDefault();
        commitTagValue(tagInputValue);
      }
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
    const title = resolveTitleText(titleElement?.textContent ?? '') || DEFAULT_TITLE;
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
    setDocumentTagsState(payload.document.tags);

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
    setDocumentTagsState(payload.document.tags);

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

  const handleTitleInput = () => {
    const raw = titleElement?.textContent ?? '';
    updateCurrentDocumentTitle(raw);
    isDirty = true;
    queueRealtimeUpdate();
  };

  const handleInput = () => {
    isDirty = true;
    queueRealtimeUpdate();
  };

  const handleBlur = () => {
    queueRealtimeUpdate({ immediate: true });
  };

  const handleTitleBlur = () => {
    if (titleElement && !sanitizeTitleText(titleElement.textContent ?? '')) {
      titleElement.textContent = DEFAULT_UNTITLED;
    }
    updateCurrentDocumentTitle(titleElement?.textContent ?? DEFAULT_UNTITLED);
    queueRealtimeUpdate({ immediate: true });
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
      closeMobileMenu();
    } else if (previousDocId) {
      desiredRealtimeDocId = previousDocId;
      await ensureRealtimeSession();
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
          message ? `Document creation failed: ${message}` : 'Document creation failed.'
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

      const { titleText, bodyHtml } = splitDocumentContent(
        payload.document.content || BLANK_DOCUMENT_MARKUP
      );

      applyDocumentContent(titleText, bodyHtml);
      updateCurrentDocumentTitle(titleText);

      if (storageKey && isBrowser) {
        window.localStorage.setItem(storageKey, payload.document.docId);
      }

      await ensureRealtimeSession();
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
    void flushRealtimeUpdates();
    teardownRealtimeConnection(true);
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
  <div
    class="flex min-h-screen w-full flex-col md:grid md:gap-12 md:[grid-template-columns:minmax(var(--edge-min),var(--edge-max))_minmax(var(--editor-min),var(--editor-max))_minmax(var(--edge-min),var(--edge-max))]"
    style="--edge-min: 12rem; --edge-max: min(20rem, 18vw); --editor-min: 28rem; --editor-max: min(70rem, calc(100vw - (2 * var(--edge-min))));"
  >
    <div
      class="relative hidden h-full md:block"
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

        {#if availableTags.length > 0 || selectedTags.length > 0}
          <section class="mb-4" aria-label="Tag filter">
            <div class="mb-2 flex items-center justify-end">
              {#if selectedTags.length > 0}
                <button
                  type="button"
                  class="text-xs font-semibold uppercase tracking-wide text-accent transition hover:text-accent/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  onclick={clearTagFilter}
                  tabindex={sidebarVisible ? 0 : -1}
                >
                  Clear
                </button>
              {/if}
            </div>

            {#if availableTags.length > 0}
              <ul class="flex flex-wrap gap-2">
                {#each availableTags as tag (tag.toLowerCase())}
                  <li>
                    <button
                      type="button"
                      class={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                        isTagSelected(tag)
                          ? 'bg-accent text-white ring-accent'
                          : 'bg-gray-50 text-gray-700 ring-gray-200 hover:ring-gray-300'
                      }`}
                      aria-pressed={isTagSelected(tag)}
                      onclick={() => toggleTagSelection(tag)}
                      tabindex={sidebarVisible ? 0 : -1}
                    >
                      {tag}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/if}

        {#if indexError}
          <p class="mb-3 text-sm text-editor-error">{indexError}</p>
        {/if}

        {#if isIndexLoading && documents.length === 0}
          <p class="mb-4 text-sm text-editor-busy">Loading…</p>
        {:else if documents.length === 0}
          <p class="mb-4 text-sm text-editor-busy">No saved documents yet.</p>
        {:else if filteredDocuments.length === 0}
          <p class="mb-4 text-sm text-editor-busy">No documents match the selected tags.</p>
        {/if}

        <nav class="flex-1" aria-label="Document titles">
          <ul class="flex-1 space-y-1 overflow-y-auto pb-2">
            {#each filteredDocuments as entry (entry.docId)}
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

    <main class="relative flex min-h-screen flex-col px-4 pb-24 pt-16 sm:px-8 md:px-10 md:pb-32 md:pt-20">
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

      <section class="flex w-full flex-1 flex-col px-4 sm:px-6 lg:px-10">
        <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col">
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

          <div class="mb-8">
            <div class="flex flex-wrap items-center gap-2 rounded-md border border-black/10 bg-white/80 px-3 py-2">
              {#each documentTags as tag (tag)}
                <span class="inline-flex items-center gap-x-1.5 rounded-full bg-gray-50 px-3 py-1 text-xs font-medium text-gray-700 ring-1 ring-inset ring-gray-500/15">
                  <span>{tag}</span>
                  <button
                    type="button"
                    class="group relative -mr-1 flex h-4 w-4 items-center justify-center rounded-sm text-gray-500 transition hover:bg-gray-500/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    onclick={() => handleTagRemove(tag)}
                  >
                    <span class="sr-only">Remove {tag}</span>
                    <svg
                      viewBox="0 0 14 14"
                      class="h-3.5 w-3.5 stroke-gray-500/70 group-hover:stroke-gray-600"
                      aria-hidden="true"
                    >
                      <path d="M4 4l6 6m0-6-6 6" fill="none" stroke-width="1.5" stroke-linecap="round" />
                    </svg>
                  </button>
                </span>
              {/each}

              <input
                id="document-tags-input"
                type="text"
                class="flex-1 border-none bg-transparent text-sm text-editor-text placeholder:text-editor-busy outline-none focus:outline-none"
                placeholder={documentTags.length === 0 ? 'Add a tag…' : 'Add another tag'}
                bind:value={tagInputValue}
                onkeydown={handleTagInputKeydown}
                onblur={handleTagInputBlur}
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
              />
            </div>

            {#if documentTags.length >= MAX_TAGS_PER_DOCUMENT}
              <p class="mt-2 text-xs text-editor-error">Tag limit reached.</p>
            {/if}
          </div>

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

          <div class="mt-6 text-sm leading-heading" aria-live="polite">
            {#if saveError}
              <span class="inline-flex items-center gap-1 text-editor-error">
                We hit a snag saving: {saveError}
              </span>
            {/if}
          </div>
        </div>
      </section>
    </main>

    <div class="relative hidden h-full md:block" aria-hidden="true"></div>
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

        {#if availableTags.length > 0 || selectedTags.length > 0}
          <section class="mb-4" aria-label="Tag filter">
            <div class="mb-2 flex items-center justify-end">
              {#if selectedTags.length > 0}
                <button
                  type="button"
                  class="text-xs font-semibold uppercase tracking-wide text-accent transition hover:text-accent/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  onclick={clearTagFilter}
                >
                  Clear
                </button>
              {/if}
            </div>

            {#if availableTags.length > 0}
              <ul class="flex flex-wrap gap-2">
                {#each availableTags as tag (tag.toLowerCase())}
                  <li>
                    <button
                      type="button"
                      class={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                        isTagSelected(tag)
                          ? 'bg-accent text-white ring-accent'
                          : 'bg-gray-50 text-gray-700 ring-gray-200 hover:ring-gray-300'
                      }`}
                      aria-pressed={isTagSelected(tag)}
                      onclick={() => toggleTagSelection(tag)}
                    >
                      {tag}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/if}

        {#if indexError}
          <p class="mb-3 text-sm text-editor-error">{indexError}</p>
        {/if}

        {#if isIndexLoading && documents.length === 0}
          <p class="mb-4 text-sm text-editor-busy">Loading…</p>
        {:else if documents.length === 0}
          <p class="mb-4 text-sm text-editor-busy">No saved documents yet.</p>
        {:else if filteredDocuments.length === 0}
          <p class="mb-4 text-sm text-editor-busy">No documents match the selected tags.</p>
        {/if}

        <nav aria-label="Document titles">
          <ul class="space-y-1 overflow-y-auto">
            {#each filteredDocuments as entry (entry.docId)}
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

  <div class="pointer-events-none fixed bottom-6 right-6 z-20 flex flex-col items-end gap-2">
    <div
      class={`flex h-12 w-12 items-center justify-center rounded-full shadow-lg ${realtimeIndicatorClass}`}
      role="status"
      aria-live="polite"
      aria-label={realtimeStatusLabel}
    >
      {#if realtimeStatus === 'connected'}
        <svg
          class="h-6 w-6 text-white"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M5 13.5 9.5 18 19 7"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
          />
        </svg>
      {:else if realtimeStatus === 'connecting'}
        <svg
          class="h-6 w-6 animate-spin text-white"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <circle
            class="opacity-30"
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            stroke-width="2"
            fill="none"
          />
          <path
            d="M21 12a9 9 0 0 0-9-9"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            fill="none"
          />
        </svg>
      {:else if realtimeStatus === 'error'}
        <svg class="h-6 w-6 text-white" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 8v5m0 4h.01M4.5 19h15l-7.5-14-7.5 14Z"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
          />
        </svg>
      {:else}
        <svg class="h-6 w-6 text-white" viewBox="0 0 24 24" aria-hidden="true">
          <circle
            cx="12"
            cy="12"
            r="2"
            fill="currentColor"
          />
        </svg>
      {/if}
    </div>

    {#if realtimeError}
      <p class="pointer-events-auto w-56 text-right text-sm text-editor-error">
        {realtimeError}
      </p>
    {/if}
  </div>
</div>
