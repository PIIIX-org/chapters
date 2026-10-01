import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  findImageMarkdown,
  imageLivePreview,
  uploadAndInsertImage,
} from './imageDecorations.js'
import * as assetsApi from '../api/assets.js'

describe('imageDecorations — parser & regex', () => {
  it('detects markdown image tags', () => {
    const doc = 'Intro\n![Architecture Diagram](/api/vaults/v1/assets/arch.svg)\nOutro'
    const items = findImageMarkdown(doc)

    expect(items).toHaveLength(1)
    expect(items[0]!.alt).toBe('Architecture Diagram')
    expect(items[0]!.src).toBe('/api/vaults/v1/assets/arch.svg')
    expect(items[0]!.from).toBe(6)
    expect(items[0]!.to).toBe(61)
  })

  it('detects images with empty alt text', () => {
    const doc = '![](https://example.com/logo.png)'
    const items = findImageMarkdown(doc)

    expect(items).toHaveLength(1)
    expect(items[0]!.alt).toBe('')
    expect(items[0]!.src).toBe('https://example.com/logo.png')
  })

  it('detects multiple images in document', () => {
    const doc =
      '![First](img1.png)\nSome text\n![Second](img2.jpg)'
    const items = findImageMarkdown(doc)

    expect(items).toHaveLength(2)
    expect(items[0]!.alt).toBe('First')
    expect(items[1]!.alt).toBe('Second')
  })
})

describe('imageLivePreview CodeMirror extension', () => {
  it('replaces image markdown with image container when cursor is elsewhere', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const doc = 'Intro\n![Mockup](https://example.com/mock.png)\nOutro'
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [imageLivePreview],
        selection: { anchor: 0 },
      }),
      parent: container,
    })

    const widget = container.querySelector('.cm-image-container')
    expect(widget).not.toBeNull()
    const img = widget?.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://example.com/mock.png')
    expect(img?.getAttribute('alt')).toBe('Mockup')

    view.destroy()
    container.remove()
  })

  it('reveals raw image markdown when cursor moves inside the image tag', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const doc = 'Intro\n![Mockup](https://example.com/mock.png)\nOutro'
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [imageLivePreview],
        selection: { anchor: 0 },
      }),
      parent: container,
    })

    // Initially replaced by widget
    expect(container.querySelector('.cm-image-container')).not.toBeNull()

    // Move cursor inside image markdown (pos 10 is inside ![Mockup]...)
    view.dispatch({ selection: { anchor: 10 } })

    // Widget is hidden, showing raw text
    expect(container.querySelector('.cm-image-container')).toBeNull()

    view.destroy()
    container.remove()
  })
})

describe('uploadAndInsertImage', () => {
  it('inserts placeholder and updates with uploaded url', async () => {
    vi.spyOn(assetsApi, 'uploadAsset').mockResolvedValue({
      fileName: 'arch-123.svg',
      url: '/api/vaults/v1/assets/arch-123.svg',
      path: 'assets/arch-123.svg',
      size: 100,
      mimeType: 'image/svg+xml',
    })

    const view = new EditorView({
      state: EditorState.create({
        doc: 'Hello world',
        selection: { anchor: 5 },
      }),
    })

    const fakeFile = new File(['fake content'], 'arch.svg', { type: 'image/svg+xml' })
    await uploadAndInsertImage(view, 'v1', fakeFile)

    const finalDoc = view.state.doc.toString()
    expect(finalDoc).toContain('![arch.svg](/api/vaults/v1/assets/arch-123.svg)')

    view.destroy()
  })

  it('inserts link without leading exclamation mark for non-image files like pdf', async () => {
    vi.spyOn(assetsApi, 'uploadAsset').mockResolvedValue({
      fileName: 'doc-456.pdf',
      url: '/api/vaults/v1/assets/doc-456.pdf',
      path: 'assets/doc-456.pdf',
      size: 200,
      mimeType: 'application/pdf',
    })

    const view = new EditorView({
      state: EditorState.create({
        doc: 'Hello world',
        selection: { anchor: 5 },
      }),
    })

    const fakeFile = new File(['fake pdf content'], 'doc.pdf', { type: 'application/pdf' })
    await uploadAndInsertImage(view, 'v1', fakeFile)

    const finalDoc = view.state.doc.toString()
    expect(finalDoc).toContain('[doc.pdf](/api/vaults/v1/assets/doc-456.pdf)')
    expect(finalDoc).not.toContain('![doc.pdf]')

    view.destroy()
  })
})
