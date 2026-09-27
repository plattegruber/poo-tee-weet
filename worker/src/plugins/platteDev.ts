/**
 * platte.dev plugin.
 *
 * A document tagged "platte.dev" and a markdown post in the platte-dot-dev
 * GitHub repo (src/posts/<slug>.md) are the same thing seen from two places.
 * Edits on either side flow to the other. If both moved before they caught up,
 * poo-tee-weet wins and git keeps the version it replaced. Removing the tag
 * stops syncing but leaves the post in place.
 */

export const PLATTE_DEV_TAG = 'platte.dev';

export interface PlatteDevEnv {
  GITHUB_TOKEN?: string;
  PLATTE_DEV_OWNER_ID?: string;
  PLATTE_DEV_REPO?: string;
  PLATTE_DEV_BRANCH?: string;
  PLATTE_DEV_POSTS_DIR?: string;
}

export interface PlatteDevDocument {
  docId: string;
  title: string;
  content: string;
  tags: string[];
  version: number;
}

export interface PlatteDevState {
  slug: string;
  publishedAt: string;
  sha: string | null;
  contentHash: string | null;
  syncedVersion: number;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export const hasPlatteDevTag = (tags: string[]): boolean =>
  tags.some((tag) => tag.toLowerCase() === PLATTE_DEV_TAG);

/** The plugin only runs for the configured owner so other accounts cannot write to the blog. */
export const isPlatteDevEnabled = (env: PlatteDevEnv, ownerId: string): boolean =>
  Boolean(env.GITHUB_TOKEN && env.PLATTE_DEV_OWNER_ID && env.PLATTE_DEV_OWNER_ID === ownerId);

// ---------------------------------------------------------------------------
// HTML to markdown
//
// The editor stores sanitized HTML limited to P, BR, DIV, B, STRONG, I, EM, U,
// S, H1 (title), H2, H3, UL, OL, LI and BLOCKQUOTE with no attributes, so a
// small hand-rolled parser is enough and keeps the Worker dependency free.
// ---------------------------------------------------------------------------

type HtmlNode =
  { type: 'text'; text: string } | { type: 'element'; tag: string; children: HtmlNode[] };

const VOID_TAGS = new Set(['br', 'hr', 'img']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });

export const parseHtml = (html: string): HtmlNode[] => {
  const root: HtmlNode = { type: 'element', tag: 'root', children: [] };
  const stack: Extract<HtmlNode, { type: 'element' }>[] = [root];
  const tokens = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>|([^<]+)|(<)/g;

  for (const match of html.matchAll(tokens)) {
    const [, closing, rawTag, text, stray] = match;
    const current = stack[stack.length - 1];

    if (text !== undefined || stray !== undefined) {
      current.children.push({ type: 'text', text: decodeEntities(text ?? stray ?? '') });
      continue;
    }

    const tag = rawTag.toLowerCase();
    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const element: Extract<HtmlNode, { type: 'element' }> = { type: 'element', tag, children: [] };
    current.children.push(element);
    if (!VOID_TAGS.has(tag)) stack.push(element);
  }

  return root.children;
};

const escapeInlineText = (text: string): string =>
  text.replace(/\u00a0/g, ' ').replace(/([\\`*_[\]<])/g, '\\$1');

const escapeLineStart = (line: string): string =>
  line.replace(/^(\s*)([#>+-])(?=\s)/, '$1\\$2').replace(/^(\s*)(\d+)([.)])(?=\s)/, '$1$2\\$3');

/** Drops hard breaks at the edges of a paragraph, which the editor emits for blank lines. */
const trimHardBreaks = (text: string): string =>
  text
    .replace(/^(\s*\\\n)+/, '')
    .replace(/(\\\n\s*)+$/, '')
    .trim();

/** Wraps a rendered inline run with a marker, keeping surrounding whitespace outside it. */
const wrapInline = (inner: string, open: string, close = open): string => {
  const leading = inner.match(/^\s*/)?.[0] ?? '';
  const trailing = inner.match(/\s*$/)?.[0] ?? '';
  const core = inner.slice(leading.length, inner.length - trailing.length);
  if (!core) return inner;
  return `${leading}${open}${core}${close}${trailing}`;
};

const renderInline = (nodes: HtmlNode[]): string => {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += escapeInlineText(node.text);
      continue;
    }
    switch (node.tag) {
      case 'br':
        out += '\\\n';
        break;
      case 'b':
      case 'strong':
        out += wrapInline(renderInline(node.children), '**');
        break;
      case 'i':
      case 'em':
        out += wrapInline(renderInline(node.children), '*');
        break;
      case 's':
      case 'del':
      case 'strike':
        out += wrapInline(renderInline(node.children), '~~');
        break;
      case 'u':
        out += wrapInline(renderInline(node.children), '<u>', '</u>');
        break;
      default:
        // Block-level tags nested inside an inline run are unwrapped to their text.
        out += renderInline(node.children);
    }
  }
  return out;
};

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote']);

const indent = (block: string, prefix: string, rest = ' '.repeat(prefix.length)): string =>
  block
    .split('\n')
    .map((line, index) => (index === 0 ? prefix + line : line ? rest + line : line))
    .join('\n');

const renderList = (node: Extract<HtmlNode, { type: 'element' }>, ordered: boolean): string => {
  const items: string[] = [];
  let counter = 0;
  for (const child of node.children) {
    if (child.type !== 'element' || child.tag !== 'li') continue;
    counter += 1;
    const blocks = renderBlocks(child.children);
    // A nested list follows its item text directly so the outer list stays tight.
    const body =
      blocks.reduce((acc, block) => {
        if (!acc) return block;
        return `${acc}${/^(-|\d+\.) /.test(block) ? '\n' : '\n\n'}${block}`;
      }, '') || ' ';
    items.push(indent(body, ordered ? `${counter}. ` : '- '));
  }
  return items.join('\n');
};

/**
 * Renders a node list as markdown blocks. Consecutive inline nodes are grouped
 * into a paragraph; empty paragraphs (the editor's blank lines) are dropped.
 */
export const renderBlocks = (nodes: HtmlNode[]): string[] => {
  const blocks: string[] = [];
  let inlineRun: HtmlNode[] = [];

  const flushInline = () => {
    if (inlineRun.length === 0) return;
    const text = trimHardBreaks(renderInline(inlineRun));
    inlineRun = [];
    if (!text) return;
    blocks.push(text.split('\n').map(escapeLineStart).join('\n'));
  };

  for (const node of nodes) {
    if (node.type === 'text' || !BLOCK_TAGS.has(node.tag)) {
      inlineRun.push(node);
      continue;
    }
    flushInline();

    switch (node.tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4': {
        const text = renderInline(node.children).replace(/\\\n/g, ' ').trim();
        if (text) blocks.push(`${'#'.repeat(Number(node.tag[1]))} ${text}`);
        break;
      }
      case 'ul':
      case 'ol': {
        const list = renderList(node, node.tag === 'ol');
        if (list) blocks.push(list);
        break;
      }
      case 'blockquote': {
        const inner = renderBlocks(node.children).join('\n\n');
        if (inner) {
          blocks.push(
            inner
              .split('\n')
              .map((line) => (line ? `> ${line}` : '>'))
              .join('\n')
          );
        }
        break;
      }
      default:
        // p, div, stray li: a paragraph, unless it holds nested blocks.
        blocks.push(...renderBlocks(node.children));
    }
  }

  flushInline();
  return blocks;
};

export const htmlToMarkdown = (html: string): string => renderBlocks(parseHtml(html)).join('\n\n');

const plainText = (nodes: HtmlNode[]): string =>
  nodes
    .map((node) => (node.type === 'text' ? node.text : plainText(node.children)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// Post assembly
// ---------------------------------------------------------------------------

const MAX_DESCRIPTION_LENGTH = 160;

/** Strips the title heading the editor prepends and returns the body nodes. */
const bodyNodes = (content: string): HtmlNode[] => {
  const nodes = parseHtml(content);
  const first = nodes.find((node) => node.type !== 'text' || node.text.trim());
  if (first && first.type === 'element' && first.tag === 'h1') {
    return nodes.filter((node) => node !== first);
  }
  return nodes;
};

const firstParagraphText = (nodes: HtmlNode[]): string => {
  for (const node of nodes) {
    if (node.type === 'element' && (node.tag === 'ul' || node.tag === 'ol')) continue;
    const text = plainText([node]);
    if (text) return text;
  }
  return '';
};

export const buildDescription = (content: string): string => {
  const text = firstParagraphText(bodyNodes(content));
  if (text.length <= MAX_DESCRIPTION_LENGTH) return text;
  const cut = text.slice(0, MAX_DESCRIPTION_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
};

export const slugify = (title: string, fallback: string): string => {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return slug || `post-${fallback.slice(0, 8)}`;
};

export const buildPostMarkdown = (document: PlatteDevDocument, publishedAt: string): string => {
  const tags = document.tags.filter((tag) => tag.toLowerCase() !== PLATTE_DEV_TAG);
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(document.title)}`,
    `date: ${JSON.stringify(publishedAt)}`,
    `description: ${JSON.stringify(buildDescription(document.content))}`,
    `tags: ${JSON.stringify(tags)}`,
    '---',
  ].join('\n');

  const body = renderBlocks(bodyNodes(document.content)).join('\n\n');
  const heading = `# ${renderInline([{ type: 'text', text: document.title }]).trim()}`;
  return `${frontmatter}\n\n${heading}\n\n${body}\n`.replace(/\n{3,}/g, '\n\n');
};

// ---------------------------------------------------------------------------
// GitHub sync
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const githubRequest = async (
  env: PlatteDevEnv,
  method: 'GET' | 'PUT',
  path: string,
  body?: unknown
): Promise<Response> =>
  fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'user-agent': 'poo-tee-weet-worker',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const repoConfig = (env: PlatteDevEnv) => ({
  repo: env.PLATTE_DEV_REPO ?? 'plattegruber/platte-dot-dev',
  branch: env.PLATTE_DEV_BRANCH ?? 'main',
  postsDir: (env.PLATTE_DEV_POSTS_DIR ?? 'src/posts').replace(/^\/+|\/+$/g, ''),
});

interface RemoteFile {
  sha: string;
  markdown: string;
}

const fromBase64 = (encoded: string): string => {
  const binary = atob(encoded.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const fetchFile = async (env: PlatteDevEnv, path: string): Promise<RemoteFile | null> => {
  const { repo, branch } = repoConfig(env);
  const response = await githubRequest(
    env,
    'GET',
    `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub read failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { sha?: string; content?: string };
  if (!data.sha) return null;
  return { sha: data.sha, markdown: data.content ? fromBase64(data.content) : '' };
};

const putFile = async (
  env: PlatteDevEnv,
  path: string,
  markdown: string,
  message: string,
  sha: string | null
): Promise<Response> => {
  const { repo, branch } = repoConfig(env);
  return githubRequest(env, 'PUT', `/repos/${repo}/contents/${path}`, {
    message,
    content: toBase64(markdown),
    branch,
    ...(sha ? { sha } : {}),
  });
};

// ---------------------------------------------------------------------------
// Markdown to HTML (the pull direction)
//
// Only the constructs the editor can produce are understood: paragraphs,
// headings, bullet and numbered lists, quotes, hard breaks, bold, italic,
// underline and strikethrough. Anything else in a hand-edited post comes
// through as plain text rather than being dropped.
// ---------------------------------------------------------------------------

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const renderInlineHtml = (text: string): string => {
  const held: string[] = [];
  const hold = (html: string) => {
    held.push(html);
    return `\u0000${held.length - 1}\u0000`;
  };

  let out = text.replace(/\\([\\`*_[\]<>#+\-.!~])/g, (_, char: string) => hold(escapeHtml(char)));
  out = out.replace(
    /<u>([\s\S]+?)<\/u>/g,
    (_, inner: string) => `${hold('<u>')}${inner}${hold('</u>')}`
  );
  out = escapeHtml(out)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^\w*])\*([^*\s](?:[^*]*?[^*\s])?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\s](?:[^_]*?[^_\s])?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '$1');
  return out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => held[Number(index)]);
};

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;

/** Joins paragraph lines: a trailing backslash or two spaces is a hard break. */
const paragraphHtml = (lines: string[]): string => {
  let html = '';
  lines.forEach((line, index) => {
    const hardBreak = /\\$|\s{2,}$/.test(line);
    const text = line.replace(/\\$/, '').trim();
    html += renderInlineHtml(text);
    if (index < lines.length - 1) html += hardBreak ? '<br>' : ' ';
  });
  return html;
};

const parseListBlock = (lines: string[], start: number): { html: string; next: number } => {
  const first = lines[start].match(LIST_ITEM);
  if (!first) return { html: '', next: start + 1 };
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    const item = line.match(LIST_ITEM);
    if (item && item[1].length === baseIndent && /\d/.test(item[2]) === ordered) {
      items.push([item[3]]);
      index += 1;
      continue;
    }
    if (!line.trim()) {
      const ahead = lines.slice(index + 1).find((candidate) => candidate.trim());
      const aheadIndent = ahead ? (ahead.match(/^\s*/)?.[0].length ?? 0) : 0;
      if (ahead && (aheadIndent > baseIndent || LIST_ITEM.test(ahead))) {
        if (aheadIndent > baseIndent) {
          items[items.length - 1]?.push('');
          index += 1;
          continue;
        }
        const aheadItem = ahead.match(LIST_ITEM);
        if (aheadItem && aheadItem[1].length === baseIndent) {
          index += 1;
          continue;
        }
      }
      break;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent > baseIndent && items.length > 0) {
      items[items.length - 1].push(line.slice(Math.min(indent, baseIndent + 2)));
      index += 1;
      continue;
    }
    break;
  }

  const inner = items
    .map((itemLines) => {
      const blocks = parseBlocks(itemLines);
      // contenteditable lists hold text directly in the <li>, not in <p>.
      const body = blocks.map((block) => block.replace(/^<p>([\s\S]*)<\/p>$/, '$1')).join('');
      return `<li>${body}</li>`;
    })
    .join('');
  return { html: ordered ? `<ol>${inner}</ol>` : `<ul>${inner}</ul>`, next: index };
};

const parseBlocks = (lines: string[]): string[] => {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(`<p>${paragraphHtml(paragraph)}</p>`);
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      flush();
      index += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flush();
      const level = heading[1].length;
      // The h1 is the title; it lives in the document's title field, not the body.
      if (level > 1) {
        const tag = level === 2 ? 'h2' : 'h3';
        blocks.push(`<${tag}>${renderInlineHtml(heading[2])}</${tag}>`);
      }
      index += 1;
      continue;
    }

    if (/^>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length && /^>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(`<blockquote>${parseBlocks(quoted).join('')}</blockquote>`);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flush();
      const list = parseListBlock(lines, index);
      blocks.push(list.html);
      index = list.next;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flush();
  return blocks;
};

export const markdownToHtml = (markdown: string): string =>
  parseBlocks(markdown.replace(/\r\n?/g, '\n').split('\n')).join('');

export interface ParsedPost {
  title: string | null;
  date: string | null;
  tags: string[];
  body: string;
}

const parseYamlValue = (raw: string): unknown => {
  const value = raw.trim();
  if (!value) return '';
  try {
    return JSON.parse(value);
  } catch {
    if (/^\[.*\]$/.test(value)) {
      return value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
    return value.replace(/^['"]|['"]$/g, '');
  }
};

export const parsePost = (markdown: string): ParsedPost => {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fields: Record<string, unknown> = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (pair) fields[pair[1]] = parseYamlValue(pair[2]);
    }
  }
  const tags = Array.isArray(fields.tags)
    ? fields.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return {
    title: typeof fields.title === 'string' ? fields.title : null,
    date: typeof fields.date === 'string' ? fields.date : null,
    tags,
    body: match ? markdown.slice(match[0].length) : markdown,
  };
};

export interface PulledDocument {
  title: string;
  content: string;
  tags: string[];
}

/** Turns a post file into the editor's document shape, keeping the plugin tag. */
export const postToDocument = (markdown: string, document: PlatteDevDocument): PulledDocument => {
  const post = parsePost(markdown);
  const title = post.title ?? document.title;
  const tags = [
    ...document.tags.filter((tag) => tag.toLowerCase() === PLATTE_DEV_TAG),
    ...post.tags.filter((tag) => tag.toLowerCase() !== PLATTE_DEV_TAG),
  ];
  return {
    title,
    content: `<h1>${escapeHtml(title)}</h1>${markdownToHtml(post.body)}`,
    tags,
  };
};

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export const initialPlatteDevState = (document: PlatteDevDocument): PlatteDevState => ({
  slug: slugify(document.title, document.docId),
  publishedAt: new Date().toISOString().slice(0, 10),
  sha: null,
  contentHash: null,
  syncedVersion: 0,
  lastSyncedAt: null,
  lastError: null,
});

export type PlatteDevOutcome =
  | { kind: 'none'; state: PlatteDevState }
  | { kind: 'pushed'; state: PlatteDevState }
  | { kind: 'pull'; state: PlatteDevState; document: PulledDocument };

const hasBody = (document: PlatteDevDocument): boolean =>
  renderBlocks(bodyNodes(document.content)).length > 0;

/** Finds an unused slug so a new document never overwrites an existing post. */
const freshSlug = async (env: PlatteDevEnv, base: string): Promise<string> => {
  const { postsDir } = repoConfig(env);
  for (let attempt = 2; attempt < 50; attempt += 1) {
    const candidate = `${base}-${attempt}`;
    if (!(await fetchFile(env, `${postsDir}/${candidate}.md`))) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
};

const push = async (
  env: PlatteDevEnv,
  document: PlatteDevDocument,
  state: PlatteDevState,
  remote: RemoteFile | null
): Promise<PlatteDevOutcome> => {
  const { postsDir } = repoConfig(env);
  const path = `${postsDir}/${state.slug}.md`;
  const markdown = buildPostMarkdown(document, state.publishedAt);
  const contentHash = await sha256(markdown);
  const now = new Date().toISOString();

  if (remote && contentHash === state.contentHash && remote.sha === state.sha) {
    return {
      kind: 'none',
      state: { ...state, syncedVersion: document.version, lastSyncedAt: now, lastError: null },
    };
  }

  const message = `Sync "${document.title}" from poo-tee-weet`;
  let sha = remote?.sha ?? null;
  let response = await putFile(env, path, markdown, message, sha);

  if (response.status === 409 || response.status === 422) {
    // The file moved under us in the last few hundred milliseconds. poo-tee-weet wins.
    sha = (await fetchFile(env, path))?.sha ?? null;
    response = await putFile(env, path, markdown, message, sha);
  }

  if (!response.ok) {
    throw new Error(`GitHub write failed (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as { content?: { sha?: string } };
  return {
    kind: 'pushed',
    state: {
      ...state,
      sha: data.content?.sha ?? sha,
      contentHash,
      syncedVersion: document.version,
      lastSyncedAt: now,
      lastError: null,
    },
  };
};

const pull = async (
  document: PlatteDevDocument,
  state: PlatteDevState,
  remote: RemoteFile
): Promise<PlatteDevOutcome> => {
  const post = parsePost(remote.markdown);
  return {
    kind: 'pull',
    document: postToDocument(remote.markdown, document),
    state: {
      ...state,
      publishedAt: post.date ?? state.publishedAt,
      sha: remote.sha,
      contentHash: await sha256(remote.markdown),
      // The caller sets syncedVersion to the version it writes.
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    },
  };
};

/**
 * Decides which way the post flows and does it.
 *
 * - Never synced: an existing file at the slug is adopted into an empty
 *   document; a document with text takes a fresh slug so nothing is clobbered.
 * - GitHub moved and the document did not: pull.
 * - The document moved (or both did): push. poo-tee-weet wins; git has history.
 * - A file deleted on GitHub while the tag is on is put back.
 */
export const reconcilePlatteDev = async (
  env: PlatteDevEnv,
  document: PlatteDevDocument,
  state: PlatteDevState
): Promise<PlatteDevOutcome> => {
  const { postsDir } = repoConfig(env);
  const localMoved = document.version !== state.syncedVersion;

  if (!state.sha) {
    const existing = await fetchFile(env, `${postsDir}/${state.slug}.md`);
    if (existing && !hasBody(document)) {
      return pull(document, state, existing);
    }
    if (existing) {
      const slug = await freshSlug(env, state.slug);
      return push(env, document, { ...state, slug }, null);
    }
    return push(env, document, state, null);
  }

  const remote = await fetchFile(env, `${postsDir}/${state.slug}.md`);
  const remoteMoved = remote?.sha !== state.sha;

  if (remote && remoteMoved && !localMoved) {
    return pull(document, state, remote);
  }
  if (!localMoved && !remoteMoved) {
    return { kind: 'none', state };
  }
  return push(env, document, state, remote);
};
