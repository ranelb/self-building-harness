import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachmentBlocks, AttachmentError, isTextLike, maxAttachmentBytes } from './attachments.ts'

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64')
const tmp = () => mkdtemp(join(tmpdir(), 'sbh-att-'))

describe('isTextLike', () => {
  it('accepts text mimes and source extensions, rejects binaries', () => {
    expect(isTextLike('text/plain', 'a.txt')).toBe(true)
    expect(isTextLike('application/json', 'a.json')).toBe(true)
    expect(isTextLike('application/octet-stream', 'a.ts')).toBe(true)
    expect(isTextLike('application/pdf', 'a.pdf')).toBe(false)
    expect(isTextLike('image/png', 'a.png')).toBe(false)
  })
})

describe('attachmentBlocks', () => {
  it('maps an image to an image block when the agent can see images', async () => {
    const root = await tmp()
    const blocks = await attachmentBlocks(
      root,
      [{ name: 'p.png', mimeType: 'image/png', data: b64('PNGDATA') }],
      { image: true }
    )
    expect(blocks).toEqual([{ type: 'image', data: b64('PNGDATA'), mimeType: 'image/png' }])
  })

  it('falls back to a file link for an image the agent cannot see', async () => {
    const root = await tmp()
    const blocks = await attachmentBlocks(
      root,
      [{ name: 'p.png', mimeType: 'image/png', data: b64('PNGDATA') }],
      { image: false }
    )
    expect(blocks[0]?.type).toBe('resource_link')
    const link = blocks[0] as Extract<(typeof blocks)[number], { type: 'resource_link' }>
    expect(link.uri.startsWith('file://')).toBe(true)
    expect(await readFile(fileURLToPath(link.uri), 'utf8')).toBe('PNGDATA')
  })

  it('inlines a text file as an embedded resource', async () => {
    const root = await tmp()
    const blocks = await attachmentBlocks(
      root,
      [{ name: 'a.txt', mimeType: 'text/plain', data: b64('hello') }],
      { image: true }
    )
    expect(blocks[0]).toMatchObject({
      type: 'resource',
      resource: { mimeType: 'text/plain', text: 'hello' },
    })
  })

  it('links a PDF as a file rather than inlining bytes', async () => {
    const root = await tmp()
    const blocks = await attachmentBlocks(
      root,
      [{ name: 'doc.pdf', mimeType: 'application/pdf', data: b64('%PDF-1.4') }],
      { image: true }
    )
    expect(blocks[0]).toMatchObject({ type: 'resource_link', name: 'doc.pdf' })
    expect(await readFile(fileURLToPath((blocks[0] as { uri: string }).uri), 'utf8')).toBe('%PDF-1.4')
  })

  it('rejects an attachment over the cap with a visible error', async () => {
    const root = await tmp()
    await expect(
      attachmentBlocks(
        root,
        [{ name: 'big.bin', mimeType: 'application/octet-stream', data: b64('12345') }],
        { image: true },
        4
      )
    ).rejects.toBeInstanceOf(AttachmentError)
    expect(maxAttachmentBytes).toBe(25 * 1024 * 1024)
  })
})
