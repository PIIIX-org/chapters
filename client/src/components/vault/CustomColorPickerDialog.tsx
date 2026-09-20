import { useState, useRef, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Button } from '../ui/button.js'
import { Plus, X } from 'lucide-react'

// --- Color Conversion Helpers ---

function hexToRgb(hex: string): [number, number, number] | null {
  const cleaned = hex.replace(/^#/, '').trim()
  if (cleaned.length === 3) {
    const r = parseInt(cleaned.charAt(0) + cleaned.charAt(0), 16)
    const g = parseInt(cleaned.charAt(1) + cleaned.charAt(1), 16)
    const b = parseInt(cleaned.charAt(2) + cleaned.charAt(2), 16)
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null
    return [r, g, b]
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16)
    const g = parseInt(cleaned.slice(2, 4), 16)
    const b = parseInt(cleaned.slice(4, 6), 16)
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null
    return [r, g, b]
  }
  return null
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toLowerCase()
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  const s = max === 0 ? 0 : d / max
  const v = max

  if (max !== min) {
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break
      case g:
        h = (b - r) / d + 2
        break
      case b:
        h = (r - g) / d + 4
        break
    }
    h /= 6
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(v * 100)]
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360
  s = Math.max(0, Math.min(100, s)) / 100
  v = Math.max(0, Math.min(100, v)) / 100

  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)

  let r = 0,
    g = 0,
    b = 0
  switch (i % 6) {
    case 0:
      r = v
      g = t
      b = p
      break
    case 1:
      r = q
      g = v
      b = p
      break
    case 2:
      r = p
      g = v
      b = t
      break
    case 3:
      r = p
      g = q
      b = v
      break
    case 4:
      r = t
      g = p
      b = v
      break
    case 5:
      r = v
      g = p
      b = q
      break
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

const STORAGE_KEY_SAVED_PALETTE = 'chapters_custom_palette'
const DEFAULT_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#ef4444']

function getSavedPalette(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SAVED_PALETTE)
    return raw ? JSON.parse(raw) : DEFAULT_PALETTE
  } catch {
    return DEFAULT_PALETTE
  }
}

function savePalette(palette: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY_SAVED_PALETTE, JSON.stringify(palette))
  } catch {
    // ignore
  }
}

interface CustomColorPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialColor?: string
  title?: string
  onConfirm: (color: string) => void
}

function ColorPickerContent({
  initialColor,
  title,
  onOpenChange,
  onConfirm,
}: {
  initialColor: string
  title: string
  onOpenChange: (open: boolean) => void
  onConfirm: (color: string) => void
}) {
  const [initialH, initialS, initialV, initialHex] = (() => {
    const rgb = hexToRgb(initialColor) || [59, 130, 246]
    const [h, s, v] = rgbToHsv(...rgb)
    return [h, s, v, initialColor.startsWith('#') ? initialColor.toLowerCase() : `#${initialColor.toLowerCase()}`] as const
  })()

  const [hue, setHue] = useState(initialH)
  const [sat, setSat] = useState(initialS)
  const [val, setVal] = useState(initialV)
  const [hex, setHex] = useState(initialHex)
  const [hexInput, setHexInput] = useState(initialHex)
  const [savedColors, setSavedColors] = useState<string[]>(getSavedPalette)

  const satValRef = useRef<HTMLDivElement>(null)
  const isDraggingSatVal = useRef(false)

  const currentHex = hex

  // Update sat/val from pointer event
  const updateSatVal = useCallback(
    (clientX: number, clientY: number) => {
      if (!satValRef.current) return
      const rect = satValRef.current.getBoundingClientRect()
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
      const y = Math.max(0, Math.min(rect.height, clientY - rect.top))
      const newSat = Math.round((x / rect.width) * 100)
      const newVal = Math.round((1 - y / rect.height) * 100)
      setSat(newSat)
      setVal(newVal)
      const computedHex = rgbToHex(...hsvToRgb(hue, newSat, newVal))
      setHex(computedHex)
      setHexInput(computedHex)
    },
    [hue],
  )

  const handlePointerDown = (e: React.PointerEvent) => {
    isDraggingSatVal.current = true
    satValRef.current?.setPointerCapture(e.pointerId)
    updateSatVal(e.clientX, e.clientY)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDraggingSatVal.current) {
      updateSatVal(e.clientX, e.clientY)
    }
  }

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isDraggingSatVal.current) {
      isDraggingSatVal.current = false
      satValRef.current?.releasePointerCapture(e.pointerId)
    }
  }

  // Handle hue slider change
  const handleHueChange = (newHue: number) => {
    setHue(newHue)
    const computedHex = rgbToHex(...hsvToRgb(newHue, sat, val))
    setHex(computedHex)
    setHexInput(computedHex)
  }

  // Handle Hex input change
  const handleHexChange = (value: string) => {
    setHexInput(value)
    const rgb = hexToRgb(value)
    if (rgb) {
      const normalized = value.startsWith('#') ? value.toLowerCase() : `#${value.toLowerCase()}`
      setHex(normalized)
      const [h, s, v] = rgbToHsv(...rgb)
      setHue(h)
      setSat(s)
      setVal(v)
    }
  }

  // Add to saved palette
  const handleAddToPalette = () => {
    const normalized = currentHex.toLowerCase()
    if (!savedColors.includes(normalized)) {
      const updated = [...savedColors, normalized]
      setSavedColors(updated)
      savePalette(updated)
    }
  }

  // Remove from saved palette
  const handleRemoveFromPalette = (colorToRemove: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const updated = savedColors.filter((c) => c !== colorToRemove)
    setSavedColors(updated)
    savePalette(updated)
  }

  // Pick a saved color
  const handleSelectSavedColor = (color: string) => {
    const rgb = hexToRgb(color)
    if (rgb) {
      const [h, s, v] = rgbToHsv(...rgb)
      setHue(h)
      setSat(s)
      setVal(v)
      setHex(color)
      setHexInput(color)
    }
  }

  const handleConfirm = () => {
    onConfirm(currentHex)
    onOpenChange(false)
  }

  const handleCancel = () => {
    onOpenChange(false)
  }

  return (
    <DialogContent className="w-[calc(100vw-1.5rem)] sm:max-w-sm max-h-[90vh] overflow-y-auto p-4 sm:p-6">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Choose or paste any custom color. Saved colors will be remembered across sessions.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4 py-1">
        {/* 2D Saturation / Value Gradient Area */}
        <div
          ref={satValRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="relative h-44 w-full rounded-md cursor-crosshair select-none overflow-hidden touch-none shadow-inner"
          style={{
            backgroundColor: `hsl(${hue}, 100%, 50%)`,
            backgroundImage: `
              linear-gradient(to top, #000000, transparent),
              linear-gradient(to right, #ffffff, transparent)
            `,
          }}
        >
          {/* Draggable indicator */}
          <div
            className="absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md pointer-events-none"
            style={{
              left: `${sat}%`,
              top: `${100 - val}%`,
              backgroundColor: currentHex,
            }}
          />
        </div>

        {/* Hue Slider */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Hue</span>
            <span>{hue}&deg;</span>
          </div>
          <input
            type="range"
            min="0"
            max="360"
            value={hue}
            onChange={(e) => handleHueChange(Number(e.target.value))}
            aria-label="Hue slider"
            className="w-full h-3.5 sm:h-3 rounded-lg appearance-none cursor-pointer focus-visible:outline-none touch-manipulation"
            style={{
              background:
                'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)',
            }}
          />
        </div>

        {/* Hex Input & Preview */}
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap sm:flex-nowrap">
          <div
            className="size-9 rounded-md border border-border shadow-xs shrink-0"
            style={{ backgroundColor: currentHex }}
            title={`Preview: ${currentHex}`}
          />
          <div className="flex-1 min-w-[110px] flex flex-col gap-1">
            <Label htmlFor="hex-code-input" className="text-xs">
              Hex Code
            </Label>
            <Input
              id="hex-code-input"
              value={hexInput}
              onChange={(e) => handleHexChange(e.target.value)}
              placeholder="#3b82f6"
              className="font-mono text-xs uppercase h-8"
            />
          </div>
          <div className="flex flex-col justify-end self-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddToPalette}
              title="Add to saved palette"
              aria-label="Add to saved palette"
              className="h-8 gap-1 text-xs px-2.5"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              <span>Save</span>
            </Button>
          </div>
        </div>

        {/* Saved Palette */}
        {savedColors.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-1">
            <span className="text-xs text-muted-foreground font-medium">
              Saved Palette:
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              {savedColors.map((color) => {
                const isSelected = currentHex.toLowerCase() === color.toLowerCase()
                return (
                  <div key={color} className="relative group">
                    <button
                      type="button"
                      onClick={() => handleSelectSavedColor(color)}
                      title={`Select ${color}`}
                      className={`size-6.5 sm:size-6 rounded-full border border-border/80 transition-transform hover:scale-110 shadow-xs touch-manipulation ${
                        isSelected
                          ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105'
                          : ''
                      }`}
                      style={{ backgroundColor: color }}
                    />
                    <button
                      type="button"
                      onClick={(e) => handleRemoveFromPalette(color, e)}
                      title={`Remove ${color}`}
                      aria-label={`Remove ${color} from saved palette`}
                      className="absolute -top-1.5 -right-1.5 sm:-top-1 sm:-right-1 size-4 sm:size-3.5 bg-background border border-border rounded-full flex items-center justify-center text-[8px] text-muted-foreground hover:text-destructive opacity-80 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity touch-manipulation"
                    >
                      <X className="size-2 sm:size-2" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Action Buttons: Cancel and Confirm */}
        <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            className="flex-1 sm:flex-none h-9 sm:h-8"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleConfirm}
            className="flex-1 sm:flex-none h-9 sm:h-8"
          >
            Confirm
          </Button>
        </div>
      </div>
    </DialogContent>
  )
}

export function CustomColorPickerDialog({
  open,
  onOpenChange,
  initialColor = '#3b82f6',
  title = 'Custom Color',
  onConfirm,
}: CustomColorPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <ColorPickerContent
          initialColor={initialColor}
          title={title}
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        />
      )}
    </Dialog>
  )
}
