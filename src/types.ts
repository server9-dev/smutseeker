export interface Book {
  isbn: string
  title: string
  authors: string[]
  description: string
  categories: string[]
  maturityRating: string // "MATURE" | "NOT_MATURE" | unknown
  thumbnail?: string
  publishedDate?: string
  pageCount?: number
}

export type DimensionKey = 'sexual' | 'violence' | 'language' | 'substances'

export interface DimensionScore {
  score: number // 0-5
  notes: string[] // what triggered it / what's inside
}

export interface Rating {
  overall: number // 0-5
  dimensions: Record<DimensionKey, DimensionScore>
  summary: string
  source: 'heuristic' | 'ai'
}

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  sexual: 'Sexual content',
  violence: 'Violence',
  language: 'Language',
  substances: 'Substances',
}

export const SPICE_LABELS = [
  'Squeaky clean', // 0
  'Tame',          // 1
  'Mild',          // 2
  'Moderate',      // 3
  'Steamy',        // 4
  'Scorching',     // 5
]
