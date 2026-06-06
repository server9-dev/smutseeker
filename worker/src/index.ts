import Anthropic from '@anthropic-ai/sdk'

export interface Env {
  RL: KVNamespace
  ANTHROPIC_API_KEY: string
  ISBNDB_KEY?: string
  HARDCOVER_TOKEN?: string
}

interface Book {
  isbn: string
  title: string
  authors: string[]
  description: string
  categories: string[]
  maturityRating: string
  thumbnail?: string
  publishedDate?: string
  pageCount?: number
  source?: string
}

// ---------------------------------------------------------------------------
// CORS — only our own front-ends may call this (and burn the keys).
// ---------------------------------------------------------------------------

const ALLOWED_EXACT = new Set([
  'https://smutseeker.otherthing.ai',
  'https://smutseeker.pages.dev',
  'http://localhost:5173',
  'http://localhost:4173',
])

function allowedOrigin(origin: string | null): string {
  if (origin && (ALLOWED_EXACT.has(origin) || /^https:\/\/[a-z0-9-]+\.smutseeker\.pages\.dev$/.test(origin))) {
    return origin
  }
  return 'https://smutseeker.otherthing.ai'
}

function cors(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(origin),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// Rate limiting — fixed-window counters in KV (approximate, abuse-proofing).
// ---------------------------------------------------------------------------

async function bump(env: Env, key: string, ttl: number): Promise<number> {
  const cur = parseInt((await env.RL.get(key)) ?? '0', 10) || 0
  const next = cur + 1
  await env.RL.put(key, String(next), { expirationTtl: ttl })
  return next
}

interface Limits {
  perMin: number
  perDay: number
  global?: number // only set for the expensive (LLM) path
}

async function enforce(env: Env, ip: string, limits: Limits): Promise<number | null> {
  const now = Date.now()
  const minute = Math.floor(now / 60000)
  const day = Math.floor(now / 86400000)

  if ((await bump(env, `m:${ip}:${minute}`, 120)) > limits.perMin) return 30
  if ((await bump(env, `d:${ip}:${day}`, 90000)) > limits.perDay) return 3600
  if (limits.global && (await bump(env, `g:${day}`, 90000)) > limits.global) return 3600
  return null
}

function limited(retryAfter: number, headers: Record<string, string>): Response {
  return json({ error: 'rate_limited', retryAfter }, 429, { ...headers, 'retry-after': String(retryAfter) })
}

// ---------------------------------------------------------------------------
// Lookup providers (server-side / keyed — these can't run in the browser).
// ---------------------------------------------------------------------------

function stripHtml(s: string): string {
  return (s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fromIsbndb(isbn: string, env: Env): Promise<Book | null> {
  if (!env.ISBNDB_KEY) return null
  const res = await fetch(`https://api2.isbndb.com/book/${encodeURIComponent(isbn)}`, {
    headers: { Authorization: env.ISBNDB_KEY },
  })
  if (!res.ok) return null
  const data = (await res.json()) as { book?: Record<string, unknown> }
  const b = data.book
  if (!b) return null
  return {
    isbn,
    title: (b.title_long as string) || (b.title as string) || 'Unknown title',
    authors: (b.authors as string[]) ?? [],
    description: stripHtml(((b.synopsis as string) || (b.overview as string) || '') as string),
    categories: ((b.subjects as string[]) ?? []).slice(0, 25),
    maturityRating: 'UNKNOWN',
    thumbnail: b.image as string | undefined,
    publishedDate: b.date_published as string | undefined,
    pageCount: b.pages as number | undefined,
    source: 'isbndb',
  }
}

// Hardcover's GraphQL schema is community-maintained; this query targets the
// common shape. If a field name drifts, adjust here — the rest is unaffected.
const HARDCOVER_QUERY = `query ($isbn: String!) {
  editions(where: { isbn_13: { _eq: $isbn } }, limit: 1) {
    title
    description
    image { url }
    book {
      title
      description
      contributions { author { name } }
      cached_tags
    }
  }
}`

function extractHardcoverTags(cached: unknown): string[] {
  // cached_tags is a JSON blob; pull any human-readable tag names defensively.
  const out: string[] = []
  const walk = (v: unknown) => {
    if (!v) return
    if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.tag === 'string') out.push(o.tag)
      else Object.values(o).forEach(walk)
    }
  }
  walk(cached)
  return [...new Set(out)].slice(0, 25)
}

async function fromHardcover(isbn: string, env: Env): Promise<Book | null> {
  if (!env.HARDCOVER_TOKEN) return null
  const res = await fetch('https://api.hardcover.app/v1/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${env.HARDCOVER_TOKEN}` },
    body: JSON.stringify({ query: HARDCOVER_QUERY, variables: { isbn } }),
  })
  if (!res.ok) return null
  const data = (await res.json()) as {
    data?: { editions?: Array<Record<string, any>> }
  }
  const ed = data?.data?.editions?.[0]
  if (!ed) return null
  const book = ed.book ?? {}
  const authors = ((book.contributions as Array<any>) ?? [])
    .map((c) => c?.author?.name)
    .filter((n: unknown): n is string => Boolean(n))
  return {
    isbn,
    title: ed.title || book.title || 'Unknown title',
    authors,
    description: stripHtml(ed.description || book.description || ''),
    categories: extractHardcoverTags(book.cached_tags),
    maturityRating: 'UNKNOWN',
    thumbnail: ed.image?.url,
    source: 'hardcover',
  }
}

async function handleBook(url: URL, env: Env, ip: string, headers: Record<string, string>): Promise<Response> {
  const retry = await enforce(env, ip, { perMin: 20, perDay: 200 })
  if (retry) return limited(retry, headers)

  const isbn = (url.searchParams.get('isbn') ?? '').replace(/[^0-9Xx]/g, '').toUpperCase()
  if (isbn.length < 10) return json({ error: 'bad_isbn' }, 400, headers)

  // ISBNdb first (broadest), Hardcover as the richer-metadata fallback.
  // Prefer the first result that actually carries a description.
  let book: Book | null = null
  for (const provider of [fromIsbndb, fromHardcover]) {
    try {
      const found = await provider(isbn, env)
      if (found && (found.description || !book)) book = found
      if (book?.description) break
    } catch (e) {
      console.warn('lookup provider failed:', e)
    }
  }
  if (!book) return json({ book: null }, 200, headers)
  return json({ book }, 200, headers)
}

// ---------------------------------------------------------------------------
// Rating — Claude Haiku with structured output.
// ---------------------------------------------------------------------------

const RATING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sexual: dim(),
    violence: dim(),
    language: dim(),
    substances: dim(),
    summary: { type: 'string' },
  },
  required: ['sexual', 'violence', 'language', 'substances', 'summary'],
}

function dim() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      score: { type: 'integer', description: '0 none, 1 trace, 2 mild, 3 moderate, 4 strong, 5 explicit/graphic' },
      note: { type: 'string', description: 'one short phrase on what is present' },
    },
    required: ['score', 'note'],
  }
}

const SYSTEM = `You are a content-safety rater for books. You receive a book's metadata (title, authors, categories, publisher maturity flag, description). Rate the ADULT CONTENT you can infer FROM THIS TEXT. Use what you also know about well-known books, but do not invent specifics for obscure ones — score conservatively when the blurb is thin and say so in the notes. Be factual and non-judgmental.`

function clamp(n: unknown): number {
  const v = Math.round(Number(n))
  return Number.isNaN(v) ? 0 : Math.max(0, Math.min(5, v))
}

async function rateWithClaude(book: Book, env: Env): Promise<unknown> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  const user = [
    `Title: ${book.title}`,
    `Authors: ${(book.authors ?? []).join(', ') || 'unknown'}`,
    `Categories: ${(book.categories ?? []).join(', ') || 'none listed'}`,
    `Publisher maturity flag: ${book.maturityRating ?? 'UNKNOWN'}`,
    `Description: ${book.description || '(none available)'}`,
  ].join('\n')

  const resp: any = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
    // Structured output — guarantees parseable JSON in the schema's shape.
    output_config: { format: { type: 'json_schema', schema: RATING_SCHEMA } },
  } as any)

  const text: string = (resp.content ?? []).find((b: any) => b.type === 'text')?.text ?? '{}'
  const parsed = JSON.parse(text)

  const dims = ['sexual', 'violence', 'language', 'substances'] as const
  const dimensions: Record<string, { score: number; notes: string[] }> = {}
  for (const k of dims) {
    const e = parsed[k] ?? {}
    dimensions[k] = { score: clamp(e.score), notes: e.note ? [String(e.note)] : [] }
  }
  const overall = Math.max(...Object.values(dimensions).map((d) => d.score), 0)
  return {
    overall,
    dimensions,
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'Rating complete.',
    source: 'ai',
  }
}

async function handleRate(request: Request, env: Env, ip: string, headers: Record<string, string>): Promise<Response> {
  // Tighter limits + a global daily budget cap protects the live Anthropic key.
  const retry = await enforce(env, ip, { perMin: 6, perDay: 40, global: 1500 })
  if (retry) return limited(retry, headers)

  let body: any
  try {
    body = await request.json()
  } catch {
    return json({ error: 'bad_json' }, 400, headers)
  }
  const book = body?.book as Book | undefined
  if (!book || !book.title) return json({ error: 'bad_request' }, 400, headers)

  try {
    const rating = await rateWithClaude(book, env)
    return json({ rating }, 200, headers)
  } catch (e: any) {
    console.error('rating failed:', e)
    return json({ error: 'rating_failed', message: String(e?.message ?? e) }, 502, headers)
  }
}

// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin')
    const headers = cors(origin)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const url = new URL(request.url)

    try {
      if (url.pathname === '/book' && request.method === 'GET') return await handleBook(url, env, ip, headers)
      if (url.pathname === '/rate' && request.method === 'POST') return await handleRate(request, env, ip, headers)
      if (url.pathname === '/') return json({ ok: true, service: 'smutseeker-api' }, 200, headers)
      return json({ error: 'not_found' }, 404, headers)
    } catch (e: any) {
      return json({ error: 'server_error', message: String(e?.message ?? e) }, 500, headers)
    }
  },
}
