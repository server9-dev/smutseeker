import { useCallback, useState } from 'react'
import { Scanner } from './Scanner'
import { lookupIsbn } from './googleBooks'
import { rateHeuristic } from './rating/heuristic'
import { aiAvailable, rateAI } from './rating/ai'
import type { Book, DimensionKey, Rating } from './types'
import { DIMENSION_LABELS, SPICE_LABELS } from './types'

type Phase = 'home' | 'scanning' | 'looking-up' | 'result' | 'notfound' | 'error'

export default function App() {
  const [phase, setPhase] = useState<Phase>('home')
  const [book, setBook] = useState<Book | null>(null)
  const [rating, setRating] = useState<Rating | null>(null)
  const [error, setError] = useState('')
  const [manual, setManual] = useState('')
  const [aiState, setAiState] = useState<{ busy: boolean; progress: string }>({ busy: false, progress: '' })

  const handleIsbn = useCallback(async (isbn: string) => {
    setPhase('looking-up')
    setError('')
    try {
      const found = await lookupIsbn(isbn)
      if (!found) {
        setPhase('notfound')
        return
      }
      setBook(found)
      setRating(rateHeuristic(found))
      setPhase('result')
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      setPhase('error')
    }
  }, [])

  const runAI = useCallback(async () => {
    if (!book) return
    setAiState({ busy: true, progress: 'Starting…' })
    try {
      const r = await rateAI(book, (text, pct) =>
        setAiState({ busy: true, progress: `${text}${pct ? ` (${Math.round(pct * 100)}%)` : ''}` }),
      )
      setRating(r)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setAiState({ busy: false, progress: '' })
    }
  }, [book])

  const reset = () => {
    setBook(null)
    setRating(null)
    setError('')
    setManual('')
    setPhase('home')
  }

  return (
    <div className="app">
      <header className="header" onClick={reset} role="button">
        <h1>🌶️ SmutSeeker</h1>
        <p className="tagline">Scan a book. See what's inside.</p>
      </header>

      {phase === 'home' && (
        <div className="card stack">
          <button className="btn btn-primary big" onClick={() => setPhase('scanning')}>
            📷 Scan a barcode
          </button>
          <div className="or">or</div>
          <form
            className="manual"
            onSubmit={(e) => {
              e.preventDefault()
              const digits = manual.replace(/[^0-9Xx]/g, '')
              if (digits.length >= 10) handleIsbn(digits)
            }}
          >
            <input
              inputMode="numeric"
              placeholder="Type an ISBN (e.g. 9780525559474)"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
            <button className="btn" type="submit">Go</button>
          </form>
        </div>
      )}

      {phase === 'scanning' && (
        <div className="card">
          <Scanner
            onResult={handleIsbn}
            onError={(msg) => {
              setError(msg)
              setPhase('error')
            }}
          />
          <button className="btn ghost" onClick={reset}>Cancel</button>
        </div>
      )}

      {phase === 'looking-up' && (
        <div className="card center">
          <div className="spinner" />
          <p>Looking up the book…</p>
        </div>
      )}

      {phase === 'notfound' && (
        <div className="card center stack">
          <p>📭 No book found for that ISBN in Google Books.</p>
          <button className="btn" onClick={reset}>Try another</button>
        </div>
      )}

      {phase === 'error' && (
        <div className="card center stack">
          <p>⚠️ {error}</p>
          <button className="btn" onClick={reset}>Back</button>
        </div>
      )}

      {phase === 'result' && book && rating && (
        <Result
          book={book}
          rating={rating}
          onReset={reset}
          onRunAI={runAI}
          aiBusy={aiState.busy}
          aiProgress={aiState.progress}
          canRunAI={aiAvailable()}
        />
      )}

      <footer className="footer">
        Ratings are heuristic / on-device AI guesses from public metadata — not gospel.
      </footer>
    </div>
  )
}

function Result({
  book,
  rating,
  onReset,
  onRunAI,
  aiBusy,
  aiProgress,
  canRunAI,
}: {
  book: Book
  rating: Rating
  onReset: () => void
  onRunAI: () => void
  aiBusy: boolean
  aiProgress: string
  canRunAI: boolean
}) {
  return (
    <div className="card stack">
      <div className="book">
        {book.thumbnail && <img className="cover" src={book.thumbnail} alt="" />}
        <div>
          <h2>{book.title}</h2>
          <p className="authors">{book.authors.join(', ') || 'Unknown author'}</p>
          {book.publishedDate && <p className="meta">{book.publishedDate}</p>}
        </div>
      </div>

      <SpiceMeter overall={rating.overall} source={rating.source} />

      <p className="summary">{rating.summary}</p>

      <div className="dims">
        {(Object.keys(rating.dimensions) as DimensionKey[]).map((k) => {
          const d = rating.dimensions[k]
          return (
            <div className="dim" key={k}>
              <div className="dim-head">
                <span>{DIMENSION_LABELS[k]}</span>
                <span className="dim-score">{d.score}/5</span>
              </div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${(d.score / 5) * 100}%` }} />
              </div>
              {d.notes.length > 0 && <p className="dim-notes">{d.notes.join(' · ')}</p>}
            </div>
          )
        })}
      </div>

      {rating.source !== 'ai' && canRunAI && (
        <button className="btn btn-primary" onClick={onRunAI} disabled={aiBusy}>
          {aiBusy ? '🧠 Analyzing…' : '🧠 Analyze with on-device AI'}
        </button>
      )}
      {rating.source !== 'ai' && !canRunAI && (
        <p className="meta">On-device AI needs WebGPU (iOS 18+, recent Chrome/Edge). Showing heuristic.</p>
      )}
      {aiBusy && <p className="meta progress">{aiProgress}</p>}

      <button className="btn ghost" onClick={onReset}>Scan another</button>
    </div>
  )
}

function SpiceMeter({ overall, source }: { overall: number; source: Rating['source'] }) {
  return (
    <div className="meter">
      <div className="peppers" aria-label={`${overall} out of 5`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={n <= overall ? 'pep on' : 'pep'}>🌶️</span>
        ))}
      </div>
      <div className="meter-label">
        {SPICE_LABELS[overall]} <span className="src">· {source === 'ai' ? 'AI' : 'heuristic'}</span>
      </div>
    </div>
  )
}
