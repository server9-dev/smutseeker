import { useEffect, useRef } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { DecodeHintType, BarcodeFormat } from '@zxing/library'
import type { IScannerControls } from '@zxing/browser'

interface Props {
  onResult: (isbn: string) => void
  onError: (msg: string) => void
}

// ISBN-13 barcodes are EAN-13 starting with 978 or 979.
const ISBN13 = /^97[89]\d{10}$/

export function Scanner({ onResult, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const hints = new Map()
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13])
    const reader = new BrowserMultiFormatReader(hints)

    let controls: IScannerControls | undefined
    let stopped = false

    reader
      .decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        videoRef.current!,
        (result) => {
          if (stopped || !result) return
          const text = result.getText()
          if (ISBN13.test(text)) {
            stopped = true
            controls?.stop()
            onResult(text)
          }
        },
      )
      .then((c) => {
        controls = c
        if (stopped) c.stop()
      })
      .catch((e) => onError(humanizeCameraError(e)))

    return () => {
      stopped = true
      controls?.stop()
    }
  }, [onResult, onError])

  return (
    <div className="scanner">
      <video ref={videoRef} className="scanner-video" muted playsInline />
      <div className="scanner-frame" />
      <p className="scanner-hint">Point at the barcode on the back of the book</p>
    </div>
  )
}

function humanizeCameraError(e: unknown): string {
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError') return 'Camera permission denied. Allow it and reload, or type the ISBN.'
  if (name === 'NotFoundError') return 'No camera found. Type the ISBN manually instead.'
  if (location.protocol !== 'https:' && location.hostname !== 'localhost')
    return 'Camera needs HTTPS. Open the hosted site, or type the ISBN.'
  return `Could not start camera: ${String((e as Error)?.message ?? e)}`
}
