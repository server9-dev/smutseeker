import type { Book } from './types'
import { lookupRemote } from './rating/remote'

/**
 * ISBN -> Book lookup with layered fallbacks (all browser-friendly / keyless):
 *   1. Google Books (richest; has a maturity flag) — retried once on 429.
 *   2. Open Library edition endpoint (per-ISBN).
 *   3. Open Library search index (catches works the edition endpoint misses).
 * Each ISBN source is tried for BOTH the ISBN-13 and ISBN-10 form, since books
 * are often indexed under only one. Results are cached per-ISBN for the session.
 *
 * NOTE: Goodreads has no usable API (Amazon shut it down in 2020) and most other
 * book DBs (ISBNdb, WorldCat) block browser CORS — those would need a CF Worker proxy.
 */

const cache = new Map<string, Book | null>()
const inflight = new Map<string, Promise<Book | null>>()

class RateLimitError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function lookupIsbn(raw: string): Promise<Book | null> {
  const clean = raw.replace(/[^0-9Xx]/g, '').toUpperCase()
  if (cache.has(clean)) return cache.get(clean)!
  if (inflight.has(clean)) return inflight.get(clean)!

  const p = (async () => {
    const candidates = isbnCandidates(clean)
    let book: Book | null = null

    // 1. Google Books, across both ISBN forms.
    for (const c of candidates) {
      try {
        book = await fromGoogle(c)
        if (book) break
      } catch (e) {
        if (!(e instanceof RateLimitError)) console.warn('Google Books lookup failed:', e)
      }
    }

    // 2. Open Library edition endpoint, across both ISBN forms.
    if (!book) {
      for (const c of candidates) {
        try {
          book = await fromOpenLibrary(c)
          if (book) break
        } catch (e) {
          console.warn('Open Library edition lookup failed:', e)
        }
      }
    }

    // 3. Open Library search index.
    if (!book) {
      for (const c of candidates) {
        try {
          book = await fromOpenLibrarySearch(c)
          if (book) break
        } catch (e) {
          console.warn('Open Library search failed:', e)
        }
      }
    }

    // 4. Server-side providers (ISBNdb / Hardcover) via the Worker — the long tail.
    if (!book) {
      book = await lookupRemote(clean)
    }

    if (book) book.isbn = clean // display the ISBN the user actually scanned
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

// --- ISBN-10 <-> ISBN-13 ----------------------------------------------------

function isbnCandidates(clean: string): string[] {
  const set = new Set<string>([clean])
  if (clean.length === 13 && clean.startsWith('978')) {
    const i10 = isbn13to10(clean)
    if (i10) set.add(i10)
  } else if (clean.length === 10) {
    const i13 = isbn10to13(clean)
    if (i13) set.add(i13)
  }
  return [...set]
}

function isbn13to10(isbn13: string): string | null {
  if (!/^978\d{10}$/.test(isbn13)) return null // 979-prefixed have no ISBN-10
  const core = isbn13.slice(3, 12)
  let sum = 0
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(core[i])
  const check = (11 - (sum % 11)) % 11
  return core + (check === 10 ? 'X' : String(check))
}

function isbn10to13(isbn10: string): string | null {
  if (!/^\d{9}[\dX]$/.test(isbn10)) return null
  const core = '978' + isbn10.slice(0, 9)
  let sum = 0
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(core[i])
  const check = (10 - (sum % 10)) % 10
  return core + String(check)
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

async function descriptionFromWorkKey(key: string | undefined): Promise<string> {
  if (!key) return ''
  try {
    const work = await fetch(`https://openlibrary.org${key}.json`).then((r) => (r.ok ? r.json() : null))
    return normalizeDescription(work?.description)
  } catch {
    return ''
  }
}

async function fromOpenLibrary(isbn: string): Promise<Book | null> {
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
      description = await descriptionFromWorkKey(ed.works[0].key)
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

async function fromOpenLibrarySearch(isbn: string): Promise<Book | null> {
  const url = `https://openlibrary.org/search.json?isbn=${isbn}&fields=key,title,author_name,first_publish_year,cover_i,subject&limit=1`
  const res = await fetch(url)
  if (!res.ok) return null
  const json = await res.json()
  const doc = (json.docs ?? [])[0] as
    | {
        key?: string // work key, e.g. /works/OL...W
        title?: string
        author_name?: string[]
        first_publish_year?: number
        cover_i?: number
        subject?: string[]
      }
    | undefined
  if (!doc) return null

  return {
    isbn,
    title: doc.title ?? 'Unknown title',
    authors: doc.author_name ?? [],
    description: await descriptionFromWorkKey(doc.key),
    categories: (doc.subject ?? []).slice(0, 25),
    maturityRating: 'UNKNOWN',
    thumbnail: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : undefined,
    publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
  }
}
