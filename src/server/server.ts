import cors from '@fastify/cors'
import staticPlugin from '@fastify/static'
import websocketPlugin from '@fastify/websocket'
import fastify from 'fastify'
import { existsSync } from 'fs'
import { resolve } from 'path'
import type { RawData } from 'ws'
import { loadAsset, storeAsset } from './assets'
import { mcpBridge } from './mcp-bridge'
import { listRooms, makeOrLoadRoom } from './rooms'
import { unfurl } from './unfurl'

const PORT = Number(process.env.PORT ?? 5858)
const IS_PROD = process.env.NODE_ENV === 'production'

const app = fastify({ logger: { level: IS_PROD ? 'info' : 'warn' } })

app.register(websocketPlugin)
app.register(cors, { origin: '*' })

// Production: serve Vite build; dev: use Vite dev server separately
const CLIENT_DIST = resolve('./dist/client')
if (IS_PROD && existsSync(CLIENT_DIST)) {
  app.register(staticPlugin, { root: CLIENT_DIST, prefix: '/', index: 'index.html' })
}

app.register(async (app) => {
  // --- WebSocket: multi-user sync -----------------------------------------
  app.get('/connect/:roomId', { websocket: true }, async (socket, req) => {
    const roomId = (req.params as Record<string, string>).roomId
    const sessionId = (req.query as Record<string, string>)?.sessionId

    // Register message listener before any await so early messages are not lost
    const caughtMessages: RawData[] = []
    const collectMessages = (msg: RawData) => caughtMessages.push(msg)
    socket.on('message', collectMessages)

    const room = makeOrLoadRoom(roomId)
    room.handleSocketConnect({ sessionId, socket })

    socket.off('message', collectMessages)

    for (const msg of caughtMessages) {
      socket.emit('message', msg)
    }
  })

  // --- Asset upload / download (local disk) --------------------------------
  app.addContentTypeParser('*', (_, __, done) => done(null))

  app.put('/uploads/:id', async (req, res) => {
    const id = (req.params as Record<string, string>).id
    await storeAsset(id, req.raw)
    res.send({ ok: true })
  })

  app.get('/uploads/:id', async (req, res) => {
    const id = (req.params as Record<string, string>).id
    try {
      const data = await loadAsset(id)
      res.header('Content-Security-Policy', "default-src 'none'")
      res.header('X-Content-Type-Options', 'nosniff')
      res.send(data)
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        res.status(404).send({ error: 'Asset not found', id })
      } else {
        throw e
      }
    }
  })

  // --- Bookmark unfurl (images/favicons cached under .assets/, served via /uploads/)
  app.get('/unfurl', async (req, res) => {
    const url = (req.query as Record<string, string>).url
    res.send(await unfurl(url))
  })

  // --- Room list (disk + in-memory active flag) ----------------------------
  app.get('/api/rooms', async (_req, res) => {
    res.send({ rooms: listRooms() })
  })

  app.get('/api/health', async (_req, res) => {
    res.send({ ok: true, mode: IS_PROD ? 'production' : 'development' })
  })

  // --- MCP bridge: MCP server ↔ browser editor -----------------------------
  app.get('/mcp-bridge', { websocket: true }, async (socket, req) => {
    const query = req.query as Record<string, string>
    const { role, roomId, token } = query

    if (!roomId) {
      socket.close(4002, 'roomId is required')
      return
    }

    if (role === 'mcp') {
      const expected = process.env.MCP_TOKEN
      if (!expected) {
        socket.close(4001, 'MCP_TOKEN not configured on server')
        return
      }
      if (token !== expected) {
        socket.close(4001, 'Unauthorized: invalid token')
        return
      }
      mcpBridge.registerMcp(roomId, socket)
    } else {
      const origin = req.headers.origin ?? ''
      const host = req.headers.host ?? ''
      if (!isAllowedOrigin(origin, host)) {
        socket.close(4003, `Forbidden origin: ${origin}`)
        return
      }
      mcpBridge.registerBrowser(roomId, socket)
    }
  })
})

// SPA fallback in production
if (IS_PROD && existsSync(CLIENT_DIST)) {
  app.setNotFoundHandler(async (_req, res) => {
    res.sendFile('index.html', CLIENT_DIST)
  })
}

// --- Helpers -----------------------------------------------------------------

/**
 * Validate browser WebSocket Origin to block foreign pages from acting as the editor client.
 *
 * Allowed: empty Origin (e.g. wscat); localhost / 127.0.0.1; same hostname as Host header.
 */
function isAllowedOrigin(origin: string, host: string): boolean {
  if (!origin) return true

  const hostname = host.split(':')[0]
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true

  try {
    const originHostname = new URL(origin).hostname
    return originHostname === hostname
  } catch {
    return false
  }
}

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }
  console.log(`✅ tldraw-selfhost listening`)
  console.log(`   http://0.0.0.0:${PORT}`)
  console.log(`   data: .rooms/ (SQLite)  .assets/ (media)`)
  if (!IS_PROD) {
    console.log(`   dev client: npm run dev:client → http://localhost:5757`)
  }
})
