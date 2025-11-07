/**
 * Cloudflare Worker entry point with Durable Objects providing
 * canonical document storage (DocumentDO) and per-user orchestration (UserIndexDO).
 * The Worker authenticates requests with Clerk before proxying to the DOs.
 */

import { verifyToken } from '@clerk/backend';

const JWT_TEMPLATE = 'poo-tee-weet';

interface Env {
  CLERK_SECRET_KEY: string;
  ALLOWED_ORIGINS?: string;
  DocumentDO: DurableObjectNamespace<DocumentDO>;
  UserIndexDO: DurableObjectNamespace<UserIndexDO>;
}

interface DocumentRecord {
  docId: string;
  ownerId: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

interface DocumentMetadata {
  docId: string;
  title: string;
  tags: string[];
  updatedAt: string;
  createdAt: string;
  version: number;
}

const MAX_TAGS_PER_DOCUMENT = 20;
const MAX_TAG_LENGTH = 48;

const sanitizeTagValue = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, MAX_TAG_LENGTH);
};

const normalizeTagsInput = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const sanitized = sanitizeTagValue(item);
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

const ensureDocumentTags = (value: unknown): string[] => {
  const normalized = normalizeTagsInput(value);
  return normalized ?? [];
};

const aggregateTags = (entries: DocumentMetadata[]): string[] => {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    for (const tag of entry.tags ?? []) {
      const sanitized = sanitizeTagValue(tag);
      if (!sanitized) {
        continue;
      }
      const key = sanitized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.set(key, sanitized);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
};

type JsonValue = Record<string, unknown>;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
} as const;

const corsHeaders = (
  request: Request,
  env: Env,
  baseHeaders: HeadersInit = {}
): Headers => {
  const headers = new Headers(baseHeaders);
  const requestOrigin = request.headers.get('Origin');
  const configuredOrigins = env.ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim());
  const allowOrigin =
    configuredOrigins && configuredOrigins.length > 0
      ? configuredOrigins.includes('*')
        ? '*'
        : configuredOrigins.includes(requestOrigin ?? '')
        ? requestOrigin
        : configuredOrigins[0]
      : requestOrigin ?? '*';
  headers.set('Access-Control-Allow-Origin', allowOrigin ?? '*');
  headers.set('Access-Control-Allow-Headers', 'authorization,content-type');
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.append('Vary', 'Origin');
  return headers;
};

const jsonResponse = (
  request: Request,
  env: Env,
  status: number,
  body: JsonValue
): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(request, env, JSON_HEADERS),
  });
};

const emptyResponse = (request: Request, env: Env, status = 204): Response =>
  new Response(null, { status, headers: corsHeaders(request, env) });

const unauthorized = (request: Request, env: Env, message?: string) =>
  jsonResponse(request, env, 401, { error: message ?? 'Unauthorized' });

/**
 * Validates Authorization header with Clerk and extracts the user id.
 */
const authenticateRequest = async (
  request: Request,
  env: Env
): Promise<{ userId: string } | Response> => {
  const authHeader = request.headers.get('Authorization');
  let token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token && request.headers.get('Upgrade') === 'websocket') {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get('auth');
    token = queryToken ?? null;
  }

  if (!token) {
    return unauthorized(request, env, 'Missing authentication token');
  }

  if (!env.CLERK_SECRET_KEY) {
    return jsonResponse(request, env, 500, { error: 'Clerk secret key not configured' });
  }

  try {
    const jwtPayload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
      template: JWT_TEMPLATE,
    });

    const resolvedUserId =
      (jwtPayload?.userId as string | undefined) ??
      (jwtPayload?.sub as string | undefined) ??
      ((jwtPayload as Record<string, unknown> | undefined)?.[
        'https://clerk.dev/user_id'
      ] as string | undefined);

    if (!resolvedUserId) {
      return jsonResponse(request, env, 401, { error: 'Failed to determine Clerk user id' });
    }

    return { userId: resolvedUserId };
  } catch (error) {
    return jsonResponse(request, env, 401, {
      error: 'Failed to verify Clerk token',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

const parseJson = async <T extends JsonValue>(
  request: Request
): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return emptyResponse(request, env);
    }

    const auth = await authenticateRequest(request, env);
    if (auth instanceof Response) {
      return auth;
    }

    const { userId } = auth;
    const url = new URL(request.url);
    const { pathname } = url;
    const upgradeHeader = request.headers.get('Upgrade');

    if (upgradeHeader === 'websocket') {
      const syncMatch = pathname.match(/^\/docs\/([a-zA-Z0-9-]+)\/sync$/);
      if (syncMatch) {
        const docId = syncMatch[1];
        const docStub = env.DocumentDO.get(env.DocumentDO.idFromName(docId));
        const doRequest = new Request(`https://do/documents/${docId}/sync`, {
          method: 'GET',
          headers: {
            'X-User-Id': userId,
            Upgrade: 'websocket',
          },
        });
        return docStub.fetch(doRequest);
      }
    }

    try {
      if (pathname === '/me/docs') {
        if (request.method === 'GET') {
          return this.listDocuments(request, env, userId);
        }

        if (request.method === 'POST') {
          return this.createDocument(request, env, userId);
        }
      }

      const docMatch = pathname.match(/^\/docs\/([a-zA-Z0-9-]+)$/);
      if (docMatch) {
        const docId = docMatch[1];

        if (request.method === 'GET') {
          return this.readDocument(request, env, userId, docId);
        }

        if (request.method === 'POST') {
          return this.updateDocument(request, env, userId, docId);
        }
      }

      return jsonResponse(request, env, 404, { error: 'Not found' });
    } catch (error) {
      return jsonResponse(request, env, 500, {
        error: 'Unhandled worker exception',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async listDocuments(request: Request, env: Env, userId: string): Promise<Response> {
    const userIdStub = env.UserIndexDO.idFromName(userId);
    const stub = env.UserIndexDO.get(userIdStub);
    const response = await stub.fetch('https://do/user/docs', {
      method: 'GET',
      headers: {
        'X-User-Id': userId,
      },
    });
    return this.forwardDoResponse(response, request, env);
  },

  async createDocument(request: Request, env: Env, userId: string): Promise<Response> {
    const payload = await parseJson<JsonValue>(request);
    if (!payload) {
      return jsonResponse(request, env, 400, { error: 'Invalid JSON payload' });
    }

    const userIdStub = env.UserIndexDO.idFromName(userId);
    const stub = env.UserIndexDO.get(userIdStub);
    const doRequest = new Request('https://do/user/docs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify(payload),
    });
    const response = await stub.fetch(doRequest);
    return this.forwardDoResponse(response, request, env);
  },

  async readDocument(
    request: Request,
    env: Env,
    userId: string,
    docId: string
  ): Promise<Response> {
    const docStub = env.DocumentDO.get(env.DocumentDO.idFromName(docId));
    const response = await docStub.fetch(`https://do/documents/${docId}`, {
      method: 'GET',
      headers: {
        'X-User-Id': userId,
      },
    });
    return this.forwardDoResponse(response, request, env);
  },

  async updateDocument(
    request: Request,
    env: Env,
    userId: string,
    docId: string
  ): Promise<Response> {
    const payload = await parseJson<JsonValue>(request);
    if (!payload) {
      return jsonResponse(request, env, 400, { error: 'Invalid JSON payload' });
    }

    const userStub = env.UserIndexDO.get(env.UserIndexDO.idFromName(userId));
    const response = await userStub.fetch(`https://do/user/docs/${docId}`, {
      method: 'POST',
      headers: {
        'X-User-Id': userId,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return this.forwardDoResponse(response, request, env);
  },

  forwardDoResponse(response: Response, request: Request, env: Env): Response {
    const headers = corsHeaders(request, env, response.headers);
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  },
};

/**
 * Durable Object responsible for a user's document index.
 */
export class UserIndexDO {
  private state: DurableObjectState;
  private env: Env;
  private initializedUserId: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Missing user id header' }), {
        status: 401,
        headers: JSON_HEADERS,
      });
    }

    const mismatchResponse = await this.ensureUserId(userId);
    if (mismatchResponse) {
      return mismatchResponse;
    }

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/user/docs') {
      return this.listDocs();
    }

    if (request.method === 'POST' && url.pathname === '/user/docs') {
      const body = await parseJson<JsonValue>(request);
      if (!body) {
        return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      return this.createDoc(userId, body);
    }

    const match = url.pathname.match(/^\/user\/docs\/([a-zA-Z0-9-]+)$/);
    if (request.method === 'POST' && match) {
      const docId = match[1];
      const body = await parseJson<JsonValue>(request);
      if (!body) {
        return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      return this.updateDoc(userId, docId, body);
    }

    if (request.method === 'POST' && url.pathname === '/user/index/sync') {
      const body = await parseJson<JsonValue>(request);
      if (!body) {
        return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      return this.syncIndexFromDocument(userId, body);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: JSON_HEADERS,
    });
  }

  private async ensureUserId(userId: string): Promise<Response | null> {
    if (this.initializedUserId) {
      return this.initializedUserId === userId
        ? null
        : new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403,
            headers: JSON_HEADERS,
          });
    }

    const stored = (await this.state.storage.get<string>('userId')) ?? null;
    if (stored) {
      this.initializedUserId = stored;
      return stored === userId
        ? null
        : new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403,
            headers: JSON_HEADERS,
          });
    }

    await this.state.storage.put('userId', userId);
    this.initializedUserId = userId;
    return null;
  }

  private async listDocs(): Promise<Response> {
    const entries =
      (await this.state.storage.get<Record<string, DocumentMetadata>>('index')) ?? {};
    const list = Object.values(entries).sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    const allTags = aggregateTags(list);

    return new Response(
      JSON.stringify({
        documents: list,
        tags: allTags,
      }),
      {
        status: 200,
        headers: JSON_HEADERS,
      }
    );
  }

  private async createDoc(userId: string, body: JsonValue): Promise<Response> {
    const docId = crypto.randomUUID();
    const payload = {
      title: (body.title as string | undefined) ?? '',
      content: (body.content as string | undefined) ?? '',
      tags: ensureDocumentTags(body.tags),
    };

    const docStub = this.env.DocumentDO.get(this.env.DocumentDO.idFromName(docId));
    const createResponse = await docStub.fetch(`https://do/documents/${docId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify({
        ...payload,
        ownerId: userId,
        initialize: true,
      }),
    });

    if (!createResponse.ok) {
      return createResponse;
    }

    const record = (await createResponse.json()) as { document: DocumentRecord };
    await this.upsertIndex(record.document);

    return new Response(JSON.stringify(record), {
      status: 201,
      headers: JSON_HEADERS,
    });
  }

  private async updateDoc(
    userId: string,
    docId: string,
    body: JsonValue
  ): Promise<Response> {
    const docStub = this.env.DocumentDO.get(this.env.DocumentDO.idFromName(docId));
    const updateResponse = await docStub.fetch(`https://do/documents/${docId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-User-Id': userId,
      },
      body: JSON.stringify(body),
    });

    if (!updateResponse.ok) {
      return updateResponse;
    }

    const record = (await updateResponse.json()) as { document: DocumentRecord };
    await this.upsertIndex(record.document);

    return new Response(JSON.stringify(record), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }

  private async upsertIndex(document: DocumentRecord): Promise<void> {
    const entries =
      (await this.state.storage.get<Record<string, DocumentMetadata>>('index')) ?? {};

    entries[document.docId] = {
      docId: document.docId,
      title: document.title,
      tags: ensureDocumentTags(document.tags),
      updatedAt: document.updatedAt,
      createdAt: document.createdAt,
      version: document.version,
    };

    await this.state.storage.put('index', entries);
  }

  private async syncIndexFromDocument(
    userId: string,
    payload: JsonValue
  ): Promise<Response> {
    const incomingOwner = payload.ownerId as string | undefined;
    if (!incomingOwner || incomingOwner !== userId) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: JSON_HEADERS,
      });
    }

    try {
      await this.upsertIndex(payload as DocumentRecord);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: JSON_HEADERS,
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: 'Failed to sync index entry',
          details: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 500,
          headers: JSON_HEADERS,
        }
      );
    }
  }
}

/**
 * Durable Object storing canonical document content.
 */
export class DocumentDO {
  private state: DurableObjectState;
  private env: Env;
  private document: DocumentRecord | null = null;
  private dirty = false;
  private persistPromise: Promise<void> | null = null;
  private connections = new Map<WebSocket, { userId: string }>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Missing user id header' }), {
        status: 401,
        headers: JSON_HEADERS,
      });
    }

    const url = new URL(request.url);
    if (request.headers.get('Upgrade') === 'websocket' && url.pathname.endsWith('/sync')) {
      return this.handleRealtimeSync(userId);
    }

    if (!url.pathname.startsWith('/documents/')) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }

    const docId = url.pathname.split('/')[2];
    if (request.method === 'GET') {
      return this.readDocument(userId);
    }

    if (request.method === 'POST') {
      const body = await parseJson<JsonValue>(request);
      if (!body) {
        return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      return this.writeDocument(userId, docId, body);
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: JSON_HEADERS,
    });
  }

  private async handleRealtimeSync(userId: string): Promise<Response> {
    const record = await this.ensureDocumentLoaded();
    if (!record) {
      return new Response(JSON.stringify({ error: 'Document does not exist' }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }

    if (record.ownerId !== userId) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: JSON_HEADERS,
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    this.connections.set(server, { userId });
    server.send(
      JSON.stringify({
        type: 'snapshot',
        document: record,
      })
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = this.connections.get(ws);
    if (!session) {
      ws.close(1011, 'Unknown session');
      return;
    }

    const text =
      typeof message === 'string'
        ? message
        : new TextDecoder().decode(message as ArrayBuffer);

    let payload: JsonValue & { type?: string };
    try {
      payload = JSON.parse(text) as JsonValue & { type?: string };
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON payload' }));
      return;
    }

    if (payload.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      return;
    }

    if (payload.type === 'update') {
      await this.handleRealtimeUpdate(ws, payload, session.userId);
      return;
    }

    ws.send(JSON.stringify({ type: 'error', message: 'Unsupported message type' }));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.connections.delete(ws);
    if (this.connections.size === 0) {
      await this.persistNow(true);
    }
  }

  async webSocketError(_ws: WebSocket, error: Error): Promise<void> {
    console.error('Realtime socket error', error);
  }

  private async handleRealtimeUpdate(
    ws: WebSocket,
    payload: JsonValue,
    userId: string
  ): Promise<void> {
    const record = await this.ensureDocumentLoaded();
    if (!record) {
      ws.send(JSON.stringify({ type: 'error', message: 'Document not initialized' }));
      return;
    }

    if (record.ownerId !== userId) {
      ws.close(4403, 'Forbidden');
      return;
    }

    const now = new Date().toISOString();
    const incomingTags = normalizeTagsInput(payload.tags);
    const nextRecord: DocumentRecord = {
      ...record,
      title: (payload.title as string | undefined) ?? record.title,
      content: (payload.content as string | undefined) ?? record.content,
      tags: incomingTags ?? record.tags,
      updatedAt: now,
      version: record.version + 1,
    };

    this.document = nextRecord;
    this.dirty = true;
    await this.persistNow();

    const ackPayload = {
      type: 'ack',
      id: typeof payload.id === 'number' ? payload.id : undefined,
      document: nextRecord,
    };
    ws.send(JSON.stringify(ackPayload));
    this.broadcastToOthers(ws, { type: 'remote-update', document: nextRecord });
  }

  private async readDocument(userId: string): Promise<Response> {
    const record = await this.ensureDocumentLoaded();
    if (!record) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }

    if (record.ownerId !== userId) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: JSON_HEADERS,
      });
    }

    return new Response(JSON.stringify({ document: record }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }

  private async writeDocument(
    userId: string,
    docId: string,
    body: JsonValue
  ): Promise<Response> {
    const now = new Date().toISOString();
    const existing = await this.ensureDocumentLoaded();

    if (!existing) {
      if (!body.initialize) {
        return new Response(JSON.stringify({ error: 'Document does not exist' }), {
          status: 404,
          headers: JSON_HEADERS,
        });
      }

      const ownerId = (body.ownerId as string | undefined) ?? userId;
      if (ownerId !== userId) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: JSON_HEADERS,
        });
      }

      const record: DocumentRecord = {
        docId,
        ownerId,
        title: (body.title as string | undefined) ?? '',
        content: (body.content as string | undefined) ?? '',
        tags: ensureDocumentTags(body.tags),
        createdAt: now,
        updatedAt: now,
        version: 1,
      };

      await this.state.storage.put('document', record);
      this.document = record;
      this.dirty = false;

      return new Response(JSON.stringify({ document: record }), {
        status: 201,
        headers: JSON_HEADERS,
      });
    }

    if (existing.ownerId !== userId) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: JSON_HEADERS,
      });
    }

    const incomingTags = normalizeTagsInput(body.tags);
    const updated: DocumentRecord = {
      ...existing,
      title: (body.title as string | undefined) ?? existing.title,
      content: (body.content as string | undefined) ?? existing.content,
      tags: incomingTags ?? existing.tags,
      updatedAt: now,
      version: existing.version + 1,
    };

    await this.state.storage.put('document', updated);
    this.document = updated;
    this.dirty = false;

    return new Response(JSON.stringify({ document: updated }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }

  private async ensureDocumentLoaded(): Promise<DocumentRecord | null> {
    if (this.document) {
      return this.document;
    }
    const stored = (await this.state.storage.get<DocumentRecord>('document')) ?? null;
    if (!stored) {
      this.document = null;
      return null;
    }
    const normalized: DocumentRecord = {
      ...stored,
      tags: ensureDocumentTags(stored.tags),
    };
    this.document = normalized;
    return normalized;
  }

  private broadcastToOthers(origin: WebSocket, payload: JsonValue): void {
    const encoded = JSON.stringify(payload);
    for (const socket of this.connections.keys()) {
      if (socket === origin) continue;
      try {
        socket.send(encoded);
      } catch (error) {
        console.error('Failed to fan-out realtime update', error);
      }
    }
  }

  private async persistNow(force = false): Promise<void> {
    if (!this.document) {
      return;
    }
    if (!force && !this.dirty) {
      return;
    }

    if (this.persistPromise) {
      await this.persistPromise;
      if (force || this.dirty) {
        await this.persistNow(force);
      }
      return;
    }

    this.persistPromise = (async () => {
      try {
        await this.state.storage.put('document', this.document);
        await this.syncIndex(this.document!);
        this.dirty = false;
      } finally {
        this.persistPromise = null;
      }
    })();

    await this.persistPromise;
  }

  private async syncIndex(record: DocumentRecord): Promise<void> {
    const ownerId = record.ownerId;
    const userStub = this.env.UserIndexDO.get(this.env.UserIndexDO.idFromName(ownerId));
    await userStub.fetch('https://do/user/index/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-User-Id': ownerId,
      },
      body: JSON.stringify(record),
    });
  }
}
