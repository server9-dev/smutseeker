import type { Book, Rating } from '../types'

// The SmutSeeker Worker: server-side ISBN lookup (ISBNdb/Hardcover) + Claude Haiku rating.
const API = import.meta.env.VITE_API_URL ?? 'https://smutseeker-api.commune-d3b.workers.dev'

export class RateLimited extends Error {
  retryAfter: number
  constructor(retryAfter: number) {
    super('rate_limited')
    this.retryAfter = retryAfter
  }
}

/** Rate a book via Claude Haiku (rate-limited + budget-capped server-side). */
export async function rateRemote(book: Book): Promise<Rating> {
  const res = await fetch(`${API}/rate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ book }),
  })
  if (res.status === 429) {
    const d = (await res.json().catch(() => ({ retryAfter: 60 }))) as { retryAfter?: number }
    throw new RateLimited(d.retryAfter ?? 60)
  }
  if (!res.ok) throw new Error(`Rating service error ${res.status}`)
  const data = (await res.json()) as { rating: Rating }
  return data.rating
}

/** Submit a short user description for a book with no public data; returns the saved book + its rating. */
export async function contributeReview(
  isbn: string,
  text: string,
  title?: string,
): Promise<{ book: Book; rating: Rating }> {
  const res = await fetch(`${API}/contribute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isbn, text, title }),
  })
  if (res.status === 429) {
    const d = (await res.json().catch(() => ({ retryAfter: 60 }))) as { retryAfter?: number }
    throw new RateLimited(d.retryAfter ?? 60)
  }
  if (!res.ok) throw new Error(`Submit failed ${res.status}`)
  return (await res.json()) as { book: Book; rating: Rating }
}

/** Final lookup fallback — ISBNdb/Hardcover behind the Worker (keyed, can't run in-browser). */
export async function lookupRemote(isbn: string): Promise<Book | null> {
  try {
    const res = await fetch(`${API}/book?isbn=${encodeURIComponent(isbn)}`)
    if (!res.ok) return null
    const data = (await res.json()) as { book: Book | null }
    return data.book ?? null
  } catch {
    return null
  }
}
