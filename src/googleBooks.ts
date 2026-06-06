import type { Book } from './types'

/**
 * Look up a book by ISBN via the Google Books API.
 * No API key required for basic queries (rate-limited per IP — fine for a handful of users).
 */
export async function lookupIsbn(isbn: string): Promise<Book | null> {
  const clean = isbn.replace(/[^0-9Xx]/g, '')
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(clean)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Google Books API error ${res.status}`)
  const data = await res.json()
  if (!data.items || data.items.length === 0) return null

  // Prefer the edition that actually carries a description.
  const items = data.items as Array<{ volumeInfo?: Record<string, unknown> }>
  const best = items.find((i) => (i.volumeInfo?.description as string)?.length) ?? items[0]
  const v = (best.volumeInfo ?? {}) as Record<string, unknown>

  return {
    isbn: clean,
    title: (v.title as string) ?? 'Unknown title',
    authors: (v.authors as string[]) ?? [],
    description: (v.description as string) ?? '',
    categories: (v.categories as string[]) ?? [],
    maturityRating: (v.maturityRating as string) ?? 'UNKNOWN',
    thumbnail: ((v.imageLinks as { thumbnail?: string })?.thumbnail ?? '').replace('http://', 'https://') || undefined,
    publishedDate: v.publishedDate as string | undefined,
    pageCount: v.pageCount as number | undefined,
  }
}
