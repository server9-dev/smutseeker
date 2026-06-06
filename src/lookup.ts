import type { Book } from './types'

/**
 * ISBN -> Book lookup with graceful degradation:
 *   1. Google Books (richest; has a maturity flag) — retried once on 429.
 *   2. Open Library (keyless, lenient) — fallback when Google is rate-limited or empty.
 * Results are cached per-ISBN for the session so re-scans don't re-hit the APIs.
 */

const cache = new Map<string, Book | null>()
const inflight = new Map<string, Promise<Book | null>>()

class RateLimitError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function lookupIsbn(isbn: string): Promise<Book | null> {
  const clean = isbn.replace(/[^0-9Xx]/g, '')
  if (cache.has(clean)) return cache.get(clean)!
  if (inflight.has(clean)) return inflight.get(clean)!

  const p = (async () => {
    let book: Book | null = null
    try {
      book = await fromGoogle(clean)
    } catch (e) {
      if (!(e instanceof RateLimitError)) console.warn('Google Books lookup failed:', e)
    }
    if (!book) {
      try {
        book = await fromOpenLibrary(clean)
      } catch (e) {
        console.warn('Open Library lookup failed:', e)
      }
    }
    cache.set(clean, book)
    return book
  })()

  inflight.set(clean, p)
  try {
    return await p
  } finally {
    inflight.delete(clean)
  }
}

// --- Google Books -----------------------------------------------------------

async function fromGoogle(isbn: string, attempt = 0): Promise<Book | null> {
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`
  const res = await fetch(url)

  if (res.status === 429) {
    if (attempt < 1) {
      await sleep(800 + Math.floor(Math.random() * 400))
      return fromGoogle(isbn, attempt + 1)
    }
    throw new RateLimitError('Google Books rate limited')
  }
  if (!res.ok) throw new Error(`Google Books API error ${res.status}`)

  const data = await res.json()
  const items = (data.items ?? []) as Array<{ volumeInfo?: Record<string, unknown> }>
  if (items.length === 0) return null

  const best = items.find((i) => (i.volumeInfo?.description as string)?.length) ?? items[0]
  const v = (best.volumeInfo ?? {}) as Record<string, unknown>

  return {
    isbn,
    title: (v.title as string) ?? 'Unknown title',
    authors: (v.authors as string[]) ?? [],
    description: (v.description as string) ?? '',
    categories: (v.categories as string[]) ?? [],
    maturityRating: (v.maturityRating as string) ?? 'UNKNOWN',
    thumbnail:
      ((v.imageLinks as { thumbnail?: string })?.thumbnail ?? '').replace('http://', 'https://') ||
      undefined,
    publishedDate: v.publishedDate as string | undefined,
    pageCount: v.pageCount as number | undefined,
  }
}

// --- Open Library -----------------------------------------------------------

function normalizeDescription(d: unknown): string {
  if (!d) return ''
  if (typeof d === 'string') return d
  if (typeof d === 'object' && 'value' in (d as object)) return String((d as { value: unknown }).value)
  return ''
}

async function fromOpenLibrary(isbn: string): Promise<Book | null> {
  // jscmd=data gives title/authors-by-name/subjects/cover; description comes from the edition/work.
  const dataUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`
  const res = await fetch(dataUrl)
  if (!res.ok) return null
  const json = await res.json()
  const entry = json[`ISBN:${isbn}`] as
    | {
        title?: string
        authors?: Array<{ name?: string }>
        subjects?: Array<{ name?: string }>
        cover?: { medium?: string; small?: string }
        publish_date?: string
        number_of_pages?: number
      }
    | undefined
  if (!entry) return null

  let description = ''
  try {
    const ed = await fetch(`https://openlibrary.org/isbn/${isbn}.json`).then((r) => (r.ok ? r.json() : null))
    description = normalizeDescription(ed?.description)
    if (!description && Array.isArray(ed?.works) && ed.works[0]?.key) {
      const work = await fetch(`https://openlibrary.org${ed.works[0].key}.json`).then((r) =>
        r.ok ? r.json() : null,
      )
      description = normalizeDescription(work?.description)
    }
  } catch {
    /* description is optional */
  }

  const categories = (entry.subjects ?? [])
    .map((s) => s.name)
    .filter((n): n is string => Boolean(n))
    .slice(0, 25)

  return {
    isbn,
    title: entry.title ?? 'Unknown title',
    authors: (entry.authors ?? []).map((a) => a.name).filter((n): n is string => Boolean(n)),
    description,
    categories,
    maturityRating: 'UNKNOWN',
    thumbnail: entry.cover?.medium ?? entry.cover?.small,
    publishedDate: entry.publish_date,
    pageCount: entry.number_of_pages,
  }
}
