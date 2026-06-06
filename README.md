# 🌶️ SmutSeeker

Scan a book's ISBN barcode and get a quick read on its adult content — a 0–5 "spice"
scale across sexual content, violence, language, and substances, with a short note on
what's actually inside.

Runs entirely in the browser. No backend, no API keys, no accounts. Works on iOS Safari,
Android Chrome, and desktop — install it to your home screen for an app-like experience.

## How it works

1. **Scan** the EAN-13 barcode (or type the ISBN) — decoded on-device with ZXing.
2. **Look up** the book via the free Google Books API (no key needed).
3. **Rate** it two ways:
   - **Heuristic** (instant, everywhere): keyword + category + maturity-flag scoring of the
     public blurb.
   - **On-device AI** (optional, WebGPU): a small LLM (WebLLM/MLC) reads the metadata and
     returns a nuanced scale + explanation. Downloaded once, then cached. No data leaves
     your device.

> Ratings are best-effort guesses from public metadata — informative, not authoritative.

## Develop

```bash
pnpm install
pnpm dev        # http://localhost:5173  (camera works on localhost)
```

## Build & deploy

```bash
pnpm build      # -> dist/
```

Static output — host anywhere with HTTPS (the camera requires it). Deployed to
Cloudflare Pages at **smutseeker.otherthing.ai**.

## Swapping the rating engine

`src/rating/ai.ts` and `src/rating/heuristic.ts` both produce the same `Rating` shape.
To use a hosted model (Claude, a local Ollama, etc.) instead of the in-browser LLM,
implement the same signature and wire it into `App.tsx` — nothing else changes.

## Stack

Vite · React · TypeScript · @zxing/browser · @mlc-ai/web-llm · Google Books API
