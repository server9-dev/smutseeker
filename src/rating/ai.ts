import type { Book, DimensionKey, DimensionScore, Rating } from '../types'

/**
 * In-browser LLM rater via WebLLM (WebGPU). Fully client-side: the model is
 * downloaded once and cached. It rates the *supplied metadata text* — it does not
 * try to recall the book from memory, which keeps a small model honest.
 *
 * Swap this file's internals for a Claude/Ollama call later; keep the same
 * exported signature and the rest of the app is unaffected.
 */

// A small, mobile-friendly instruct model. Bump to a 3B for desktop quality.
const MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC'

export function aiAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let enginePromise: Promise<any> | null = null

export async function preloadEngine(onProgress?: (text: string, pct: number) => void) {
  if (!enginePromise) {
    enginePromise = (async () => {
      const webllm = await import('@mlc-ai/web-llm')
      return webllm.CreateMLCEngine(MODEL, {
        initProgressCallback: (r: { text: string; progress: number }) =>
          onProgress?.(r.text, r.progress),
      })
    })()
  }
  return enginePromise
}

const SYSTEM = `You are a content-safety rater for books. You will be given a book's metadata (title, categories, publisher maturity flag, and description blurb). Rate the ADULT CONTENT you can infer FROM THIS TEXT ONLY. Do not invent details you cannot infer.

Return ONLY a JSON object, no prose, with this exact shape:
{
  "sexual":     {"score": 0-5, "note": "one short phrase on what's present"},
  "violence":   {"score": 0-5, "note": "one short phrase"},
  "language":   {"score": 0-5, "note": "one short phrase"},
  "substances": {"score": 0-5, "note": "one short phrase"},
  "summary": "one sentence overall, plain and non-judgmental"
}
Scale: 0 none, 1 trace, 2 mild, 3 moderate, 4 strong, 5 explicit/graphic. If the blurb is thin, say so in the notes and score conservatively.`

export async function rateAI(
  book: Book,
  onProgress?: (text: string, pct: number) => void,
): Promise<Rating> {
  const engine = await preloadEngine(onProgress)

  const user = [
    `Title: ${book.title}`,
    `Authors: ${book.authors.join(', ') || 'unknown'}`,
    `Categories: ${book.categories.join(', ') || 'none listed'}`,
    `Publisher maturity flag: ${book.maturityRating}`,
    `Description: ${book.description || '(no description available)'}`,
  ].join('\n')

  const resp = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    temperature: 0,
    max_tokens: 400,
    response_format: { type: 'json_object' },
  })

  const raw: string = resp.choices[0]?.message?.content ?? '{}'
  return parseRating(raw)
}

function clampScore(n: unknown): number {
  const v = Math.round(Number(n))
  if (Number.isNaN(v)) return 0
  return Math.max(0, Math.min(5, v))
}

function parseRating(raw: string): Rating {
  let obj: Record<string, unknown> = {}
  try {
    // Be forgiving: extract the first {...} block in case the model adds stray text.
    const match = raw.match(/\{[\s\S]*\}/)
    obj = JSON.parse(match ? match[0] : raw)
  } catch {
    throw new Error('AI returned unparseable output — try again or use the heuristic.')
  }

  const dims = {} as Record<DimensionKey, DimensionScore>
  ;(['sexual', 'violence', 'language', 'substances'] as DimensionKey[]).forEach((k) => {
    const entry = (obj[k] ?? {}) as { score?: unknown; note?: unknown }
    dims[k] = {
      score: clampScore(entry.score),
      notes: entry.note ? [String(entry.note)] : [],
    }
  })

  const overall = Math.max(...Object.values(dims).map((d) => d.score), 0)
  return {
    overall,
    dimensions: dims,
    summary: typeof obj.summary === 'string' ? obj.summary : 'AI rating complete.',
    source: 'ai',
  }
}
