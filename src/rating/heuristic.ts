import type { Book, DimensionKey, DimensionScore, Rating } from '../types'
import { DIMENSION_LABELS, SPICE_LABELS } from '../types'

/**
 * Fast, offline keyword/metadata heuristic. Works everywhere (no WebGPU, no network
 * beyond the ISBN lookup). It's deliberately blunt — it reads the Google Books
 * blurb + categories + maturity flag. Use the AI provider for nuance.
 */

const KEYWORDS: Record<DimensionKey, string[]> = {
  sexual: [
    'erotic', 'erotica', 'sex', 'sexual', 'seduc', 'steamy', 'sensual', 'explicit',
    'desire', 'lust', 'lover', 'affair', 'intimate', 'passion', 'bdsm', 'arousal',
    'naked', 'nude', 'forbidden romance', 'spicy', 'taboo',
  ],
  violence: [
    'murder', 'kill', 'blood', 'war', 'gore', 'violent', 'violence', 'brutal',
    'torture', 'assault', 'massacre', 'slaughter', 'combat', 'gun', 'weapon',
    'corpse', 'serial killer', 'bloodshed',
  ],
  language: [
    'profanity', 'swearing', 'foul language', 'expletive', 'crude', 'vulgar',
    'strong language',
  ],
  substances: [
    'drug', 'addiction', 'addict', 'alcohol', 'heroin', 'cocaine', 'meth',
    'overdose', 'narcotic', 'substance abuse',
  ],
}

const CATEGORY_HINTS: Array<{ re: RegExp; dim: DimensionKey; weight: number; note: string }> = [
  { re: /erotic/i, dim: 'sexual', weight: 5, note: 'Categorized as Erotica' },
  { re: /romance/i, dim: 'sexual', weight: 2, note: 'Categorized as Romance' },
  { re: /horror/i, dim: 'violence', weight: 3, note: 'Categorized as Horror' },
  { re: /(true crime|crime)/i, dim: 'violence', weight: 2, note: 'Categorized as Crime' },
  { re: /(war|military)/i, dim: 'violence', weight: 2, note: 'Categorized as War/Military' },
  { re: /(juvenile|children|young adult|middle grade)/i, dim: 'sexual', weight: -3, note: "Categorized for younger readers" },
]

function countToScore(count: number): number {
  if (count <= 0) return 0
  if (count === 1) return 2
  if (count === 2) return 3
  if (count === 3) return 4
  return 5
}

export function rateHeuristic(book: Book): Rating {
  const haystack = `${book.title} ${book.description} ${book.categories.join(' ')}`.toLowerCase()

  const dimensions = {} as Record<DimensionKey, DimensionScore>
  ;(Object.keys(KEYWORDS) as DimensionKey[]).forEach((dim) => {
    const hits = KEYWORDS[dim].filter((kw) => haystack.includes(kw))
    const notes: string[] = []
    if (hits.length) notes.push(`Mentions: ${hits.slice(0, 5).join(', ')}`)
    dimensions[dim] = { score: countToScore(hits.length), notes }
  })

  // Category adjustments.
  for (const hint of CATEGORY_HINTS) {
    if (book.categories.some((c) => hint.re.test(c))) {
      const d = dimensions[hint.dim]
      d.score = Math.max(0, Math.min(5, d.score + hint.weight))
      d.notes.push(hint.note)
    }
  }

  // Publisher maturity flag.
  if (book.maturityRating === 'MATURE') {
    dimensions.sexual.score = Math.max(dimensions.sexual.score, 3)
    dimensions.sexual.notes.push('Flagged "Mature" by the publisher')
  }

  const overall = Math.max(...(Object.values(dimensions).map((d) => d.score)), 0)

  return {
    overall,
    dimensions,
    summary: buildSummary(book, dimensions, overall),
    source: 'heuristic',
  }
}

function buildSummary(book: Book, dims: Record<DimensionKey, DimensionScore>, overall: number): string {
  if (!book.description && book.categories.length === 0) {
    return `Not enough metadata on this edition to judge. Rated ${SPICE_LABELS[overall]} by default — try the AI analysis or a different ISBN.`
  }
  const flagged = (Object.keys(dims) as DimensionKey[])
    .filter((k) => dims[k].score >= 2)
    .map((k) => DIMENSION_LABELS[k].toLowerCase())
  if (flagged.length === 0) {
    return `Nothing notable jumped out of the description. Reads as ${SPICE_LABELS[overall]}.`
  }
  return `${SPICE_LABELS[overall]} overall — signals of ${flagged.join(', ')} in the description. (Heuristic guess; run AI analysis for detail.)`
}
