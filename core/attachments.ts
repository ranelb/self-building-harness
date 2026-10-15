/**
 * Prompt attachments: persist the bytes under SBH state, then map each one to an
 * ACP content block.
 *
 * The frontend ships bytes, never paths — the same code then works in the desktop
 * webview, a browser and a phone. The core does the writing because it is local and
 * owns the filesystem; this is SBH state, not a harness session store, so the
 * "never the writer" invariant is untouched.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Attachment } from '../shared/protocol.ts'

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | {
      type: 'resource'
      resource: { uri: string; mimeType: string; text?: string; blob?: string }
    }
  | { type: 'resource_link'; uri: string; name: string; mimeType: string }

/** Per-attachment cap. Base64 over loopback is cheap; a 500 MB file is not. */
export const maxAttachmentBytes = 25 * 1024 * 1024

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentError'
  }
}

const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'fish',
  'css', 'scss', 'less', 'html', 'htm', 'md', 'markdown', 'mdx', 'yml', 'yaml',
  'toml', 'ini', 'cfg', 'conf', 'env', 'sql', 'graphql', 'gql', 'proto', 'xml',
  'csv', 'tsv', 'txt', 'log',
])

/** Whether a file should be inlined as text rather than handed over as a link. */
export function isTextLike(mimeType: string, name: string): boolean {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('text/')) return true
  if (
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/x-yaml' ||
    mime === 'application/yaml'
  ) {
    return true
  }
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return true
  const extension = name.toLowerCase().split('.').pop() ?? ''
  return TEXT_EXTENSIONS.has(extension)
}

/** A filename that cannot escape the attachments directory. */
const safeName = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  return cleaned || 'file'
}

/**
 * Write every attachment under `root` and return its ACP content blocks, in order.
 * `limitBytes` is injectable so the cap can be tested without a 25 MB fixture.
 */
export async function attachmentBlocks(
  root: string,
  attachments: readonly Attachment[],
  caps: { image: boolean },
  limitBytes: number = maxAttachmentBytes
): Promise<AcpContentBlock[]> {
  await mkdir(root, { recursive: true })
  const blocks: AcpContentBlock[] = []
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index]
    if (!attachment) continue
    const bytes = Buffer.byteLength(attachment.data, 'base64')
    if (bytes > limitBytes) {
      const mb = (value: number) => Math.round(value / 1024 / 1024)
      throw new AttachmentError(
        `${attachment.name} is ${mb(bytes)} MB, over the ${mb(limitBytes)} MB attachment cap`
      )
    }
    const path = join(root, `${index}-${safeName(attachment.name)}`)
    const buffer = Buffer.from(attachment.data, 'base64')
    await writeFile(path, buffer)
    const uri = pathToFileURL(path).href
    const mimeType = attachment.mimeType || 'application/octet-stream'

    if (mimeType.startsWith('image/') && caps.image) {
      blocks.push({ type: 'image', data: attachment.data, mimeType })
      continue
    }
    if (isTextLike(mimeType, attachment.name)) {
      blocks.push({
        type: 'resource',
        resource: { uri, mimeType, text: buffer.toString('utf8') },
      })
      continue
    }
    blocks.push({ type: 'resource_link', uri, name: attachment.name, mimeType })
  }
  return blocks
}
