import { createHash } from 'crypto'
import { access, mkdir, writeFile } from 'fs/promises'
import { extname, join, resolve } from 'path'
import { unfurl as _unfurl } from 'unfurl.js'

const ASSETS_DIR = resolve('./.assets')

// Download remote images into .assets/ and return a local /uploads/ URL (avoids third-party CORP issues).
async function downloadToLocal(srcUrl: string | undefined): Promise<string | undefined> {
  if (!srcUrl) return undefined

  try {
    const res = await fetch(srcUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) return undefined

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.startsWith('image/')) return undefined

    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length === 0) return undefined

    const extByMime: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'image/x-icon': '.ico',
      'image/vnd.microsoft.icon': '.ico',
    }
    const mime = contentType.split(';')[0].trim()
    const ext = extByMime[mime] || extname(new URL(srcUrl).pathname) || '.png'

    const hash = createHash('sha256').update(srcUrl).digest('hex').slice(0, 16)
    const filename = `unfurl-${hash}${ext}`
    const filepath = join(ASSETS_DIR, filename)

    const alreadyExists = await access(filepath).then(() => true).catch(() => false)
    if (!alreadyExists) {
      await mkdir(ASSETS_DIR, { recursive: true })
      await writeFile(filepath, buffer)
      console.log('[unfurl] cached:', filename)
    } else {
      console.log('[unfurl] cache hit:', filename)
    }

    return `/uploads/${encodeURIComponent(filename)}`
  } catch (e) {
    console.warn('[unfurl] download failed:', srcUrl, (e as Error).message)
    return undefined
  }
}

function resolveUrl(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined
  try {
    return new URL(raw, base).href
  } catch {
    return undefined
  }
}

// Favicon resolution order: unfurl result → /favicon.ico → DuckDuckGo icons API
async function resolveFavicon(
  rawFavicon: string | undefined,
  pageUrl: string
): Promise<string | undefined> {
  const origin = new URL(pageUrl).origin

  const candidates: (string | undefined)[] = [
    resolveUrl(rawFavicon, pageUrl),
    `${origin}/favicon.ico`,
    `https://icons.duckduckgo.com/ip3/${new URL(pageUrl).hostname}.ico`,
  ]

  for (const url of candidates) {
    const local = await downloadToLocal(url)
    if (local) return local
  }

  return undefined
}

export async function unfurl(url: string) {
  let title: string | undefined
  let description: string | undefined
  let rawImage: string | undefined
  let rawFavicon: string | undefined

  try {
    const result = await _unfurl(url)
    title = result.title
    description = result.description
    rawImage =
      result.open_graph?.images?.[0]?.url ??
      result.twitter_card?.images?.[0]?.url
    rawFavicon = result.favicon
  } catch (e) {
    console.warn('[unfurl] parse failed:', url, (e as Error).message)
  }

  const [image, favicon] = await Promise.all([
    downloadToLocal(resolveUrl(rawImage, url)),
    resolveFavicon(rawFavicon, url),
  ])

  return { title, description, image, favicon }
}
