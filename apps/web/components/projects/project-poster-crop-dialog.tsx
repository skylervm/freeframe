'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'

const CROP_SIZE = 320
const OUTPUT_SIZE = 800

type Offset = { x: number; y: number }

interface ProjectPosterCropDialogProps {
  file: File | null
  onCancel: () => void
  onConfirm: (file: File) => void
}

export function ProjectPosterCropDialog({
  file,
  onCancel,
  onConfirm,
}: ProjectPosterCropDialogProps) {
  const [image, setImage] = React.useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = React.useState(1)
  const [offset, setOffset] = React.useState<Offset>({ x: 0, y: 0 })
  const [cropError, setCropError] = React.useState<string | null>(null)
  const dragStart = React.useRef<{ point: Offset; offset: Offset } | null>(null)
  const frameRef = React.useRef<HTMLDivElement>(null)
  const [frameSize, setFrameSize] = React.useState(CROP_SIZE)
  const previousFrameSize = React.useRef(CROP_SIZE)

  const sourceUrl = React.useMemo(() => file ? URL.createObjectURL(file) : null, [file])

  React.useEffect(() => () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl)
  }, [sourceUrl])

  React.useEffect(() => {
    setImage(null)
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setCropError(null)
  }, [file])

  React.useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const updateSize = () => setFrameSize(frame.clientWidth || CROP_SIZE)
    updateSize()
    if (!window.ResizeObserver) return
    const observer = new ResizeObserver(updateSize)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [file])

  const dimensions = React.useMemo(() => {
    if (!image) return null
    const base = Math.max(frameSize / image.naturalWidth, frameSize / image.naturalHeight)
    return {
      width: image.naturalWidth * base * zoom,
      height: image.naturalHeight * base * zoom,
    }
  }, [frameSize, image, zoom])

  const clampOffset = React.useCallback((next: Offset, nextZoom = zoom): Offset => {
    if (!image) return next
    const base = Math.max(frameSize / image.naturalWidth, frameSize / image.naturalHeight)
    const width = image.naturalWidth * base * nextZoom
    const height = image.naturalHeight * base * nextZoom
    return {
      x: Math.min(0, Math.max(frameSize - width, next.x)),
      y: Math.min(0, Math.max(frameSize - height, next.y)),
    }
  }, [frameSize, image, zoom])

  React.useEffect(() => {
    const previousSize = previousFrameSize.current
    previousFrameSize.current = frameSize
    if (!image || previousSize === frameSize) return
    const ratio = frameSize / previousSize
    setOffset((current) => clampOffset({
      x: current.x * ratio,
      y: current.y * ratio,
    }))
  }, [clampOffset, frameSize, image])

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const loaded = event.currentTarget
    setImage(loaded)
    const base = Math.max(frameSize / loaded.naturalWidth, frameSize / loaded.naturalHeight)
    setOffset({
      x: (frameSize - loaded.naturalWidth * base) / 2,
      y: (frameSize - loaded.naturalHeight * base) / 2,
    })
  }

  const handleImageError = () => {
    setImage(null)
    setCropError('This image could not be cropped. Choose another cover and try again.')
  }

  const handleZoom = (value: number) => {
    if (!dimensions) return
    const nextZoom = Number(value)
    const previousWidth = dimensions.width
    const previousHeight = dimensions.height
    const base = Math.max(frameSize / image!.naturalWidth, frameSize / image!.naturalHeight)
    const nextWidth = image!.naturalWidth * base * nextZoom
    const nextHeight = image!.naturalHeight * base * nextZoom
    const next = {
      x: frameSize / 2 - (frameSize / 2 - offset.x) * (nextWidth / previousWidth),
      y: frameSize / 2 - (frameSize / 2 - offset.y) * (nextHeight / previousHeight),
    }
    setZoom(nextZoom)
    setOffset(clampOffset(next, nextZoom))
  }

  const handleCrop = async () => {
    if (!file || !image || !dimensions) return
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_SIZE
    canvas.height = OUTPUT_SIZE
    const context = canvas.getContext('2d')
    if (!context) {
      setCropError('Your browser could not create this cover. Choose another image and try again.')
      return
    }
    try {
      const outputScale = OUTPUT_SIZE / frameSize
      context.drawImage(
        image,
        offset.x * outputScale,
        offset.y * outputScale,
        dimensions.width * outputScale,
        dimensions.height * outputScale,
      )
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
      if (!blob) throw new Error('Cover export failed')
      onConfirm(new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'cover'}.jpg`, { type: 'image/jpeg' }))
    } catch {
      setCropError('Your browser could not create this cover. Choose another image and try again.')
    }
  }

  return (
    <Dialog.Root open={!!file} onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[70] w-[min(calc(100vw-2rem),30rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-5 shadow-2xl">
          <Dialog.Title className="text-base font-semibold text-text-primary">Crop cover</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-secondary">Drag to position the image, then zoom to frame it.</Dialog.Description>

          <div
            ref={frameRef}
            className="relative mx-auto mt-5 aspect-square w-full max-w-80 overflow-hidden rounded-lg bg-black touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            tabIndex={0}
            aria-label="Cover crop position. Use arrow keys to reposition the image."
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              dragStart.current = { point: { x: event.clientX, y: event.clientY }, offset }
            }}
            onPointerMove={(event) => {
              if (!dragStart.current) return
              setOffset(clampOffset({
                x: dragStart.current.offset.x + event.clientX - dragStart.current.point.x,
                y: dragStart.current.offset.y + event.clientY - dragStart.current.point.y,
              }))
            }}
            onPointerUp={() => { dragStart.current = null }}
            onPointerCancel={() => { dragStart.current = null }}
            onKeyDown={(event) => {
              const movement = event.shiftKey ? 24 : 8
              const movementByKey: Record<string, Offset> = {
                ArrowLeft: { x: -movement, y: 0 },
                ArrowRight: { x: movement, y: 0 },
                ArrowUp: { x: 0, y: -movement },
                ArrowDown: { x: 0, y: movement },
              }
              const movementOffset = movementByKey[event.key]
              if (!movementOffset) return
              event.preventDefault()
              setOffset(clampOffset({
                x: offset.x + movementOffset.x,
                y: offset.y + movementOffset.y,
              }))
            }}
          >
            {sourceUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={sourceUrl}
                alt="Crop preview"
                onLoad={handleImageLoad}
                onError={handleImageError}
                draggable={false}
                className="absolute max-w-none select-none"
                style={dimensions ? { width: dimensions.width, height: dimensions.height, left: offset.x, top: offset.y } : undefined}
              />
            )}
          </div>

          <label className="mt-5 block text-xs font-medium text-text-tertiary" htmlFor="cover-zoom">Zoom</label>
          <input
            id="cover-zoom"
            aria-label="Zoom"
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(event) => handleZoom(Number(event.target.value))}
            className="mt-2 w-full accent-accent"
          />
          {cropError && <p role="alert" className="mt-3 text-sm text-status-error">{cropError}</p>}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onCancel}>{cropError ? 'Choose another' : 'Cancel'}</Button>
            <Button size="sm" onClick={handleCrop} disabled={!image}>Use crop</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
