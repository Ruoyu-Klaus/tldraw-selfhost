import { createHash } from 'crypto'
import { access, mkdir, writeFile } from 'fs/promises'
import { extname, join, resolve } from 'path'
import { unfurl as _unfurl } from 'unfurl.js'

const ASSETS_DIR = resolve('./.assets')

// ── 工具：把外部图片下载到本地 .assets/，返回本地路径 ─────────────────────
// 这样浏览器只需加载我们自己的服务，完全绕过目标站点的 CORP 头限制。
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

    // 扩展名：优先从 Content-Type 推断
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

    // 用 URL 的 SHA-256 做文件名，保证不同 URL 不会碰撞
    const hash = createHash('sha256').update(srcUrl).digest('hex').slice(0, 16)
    const filename = `unfurl-${hash}${ext}`
    const filepath = join(ASSETS_DIR, filename)

    // 文件已存在则跳过下载，直接复用缓存
    const alreadyExists = await access(filepath).then(() => true).catch(() => false)
    if (!alreadyExists) {
      await mkdir(ASSETS_DIR, { recursive: true })
      await writeFile(filepath, buffer)
      console.log('[unfurl] 已下载并缓存:', filename)
    } else {
      console.log('[unfurl] 复用已有缓存:', filename)
    }

    return `/uploads/${encodeURIComponent(filename)}`
  } catch (e) {
    console.warn('[unfurl] 下载失败:', srcUrl, (e as Error).message)
    return undefined
  }
}

// ── 工具：把可能是相对路径的 URL 解析为绝对 URL ──────────────────────────
function resolveUrl(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined
  try {
    return new URL(raw, base).href
  } catch {
    return undefined
  }
}

// ── 工具：用多种策略可靠获取 favicon ────────────────────────────────────────
// 策略顺序：
// 1. unfurl.js 解析到的 favicon（修正相对路径后）
// 2. 直接请求 /favicon.ico
// 3. DuckDuckGo favicon API（兜底，几乎 100% 有效）
async function resolveFavicon(
  rawFavicon: string | undefined,
  pageUrl: string
): Promise<string | undefined> {
  const origin = new URL(pageUrl).origin

  const candidates: (string | undefined)[] = [
    resolveUrl(rawFavicon, pageUrl),                      // 1. unfurl.js 结果
    `${origin}/favicon.ico`,                              // 2. 默认 favicon.ico
    `https://icons.duckduckgo.com/ip3/${new URL(pageUrl).hostname}.ico`, // 3. DDG API
  ]

  for (const url of candidates) {
    const local = await downloadToLocal(url)
    if (local) return local
  }

  return undefined
}

// ── 主函数 ────────────────────────────────────────────────────────────────
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
    console.warn('[unfurl] 解析页面失败:', url, (e as Error).message)
  }

  // 并行处理 OG 图片和 favicon，互不阻塞
  const [image, favicon] = await Promise.all([
    downloadToLocal(resolveUrl(rawImage, url)),
    resolveFavicon(rawFavicon, url),
  ])

  return { title, description, image, favicon }
}
