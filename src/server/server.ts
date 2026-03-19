import cors from '@fastify/cors'
import staticPlugin from '@fastify/static'
import websocketPlugin from '@fastify/websocket'
import fastify from 'fastify'
import { existsSync } from 'fs'
import { resolve } from 'path'
import type { RawData } from 'ws'
import { loadAsset, storeAsset } from './assets'
import { listRooms, makeOrLoadRoom } from './rooms'
import { unfurl } from './unfurl'

const PORT = Number(process.env.PORT ?? 5858)
const IS_PROD = process.env.NODE_ENV === 'production'

const app = fastify({ logger: { level: IS_PROD ? 'info' : 'warn' } })

app.register(websocketPlugin)
app.register(cors, { origin: '*' })

// 生产模式：直接托管前端构建产物，开发模式下交给 Vite dev server
const CLIENT_DIST = resolve('./dist/client')
if (IS_PROD && existsSync(CLIENT_DIST)) {
  app.register(staticPlugin, { root: CLIENT_DIST, prefix: '/', index: 'index.html' })
}

app.register(async (app) => {
  // ── WebSocket：多人实时同步入口 ────────────────────────────────────────
  app.get('/connect/:roomId', { websocket: true }, async (socket, req) => {
    const roomId = (req.params as Record<string, string>).roomId
    const sessionId = (req.query as Record<string, string>)?.sessionId

    // 必须在任何异步操作前先注册 message 监听，否则早期消息会丢失
    const caughtMessages: RawData[] = []
    const collectMessages = (msg: RawData) => caughtMessages.push(msg)
    socket.on('message', collectMessages)

    const room = makeOrLoadRoom(roomId)
    room.handleSocketConnect({ sessionId, socket })

    socket.off('message', collectMessages)

    // 回放在房间加载前收到的消息
    for (const msg of caughtMessages) {
      socket.emit('message', msg)
    }
  })

  // ── 资源上传/下载（图片、视频等大文件存本地磁盘）─────────────────────
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
      // 防止用户上传的 SVG 触发 XSS
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

  // ── 书签 unfurl（链接预览）────────────────────────────────────────────
  // image / favicon 已在 unfurl.ts 中下载到本地 .assets/，返回本地 /uploads/ 路径
  app.get('/unfurl', async (req, res) => {
    const url = (req.query as Record<string, string>).url
    res.send(await unfurl(url))
  })

  // ── 房间列表（磁盘上所有房间 + 活跃状态）────────────────────────────
  app.get('/api/rooms', async (_req, res) => {
    res.send({ rooms: listRooms() })
  })

  // ── 健康检查 ──────────────────────────────────────────────────────────
  app.get('/api/health', async (_req, res) => {
    res.send({ ok: true, mode: IS_PROD ? 'production' : 'development' })
  })
})

// SPA fallback：生产模式下所有未匹配的路由都返回 index.html
if (IS_PROD && existsSync(CLIENT_DIST)) {
  app.setNotFoundHandler(async (_req, res) => {
    res.sendFile('index.html', CLIENT_DIST)
  })
}

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }
  console.log(`✅ tldraw-selfhost 服务启动`)
  console.log(`   后端监听：http://0.0.0.0:${PORT}`)
  console.log(`   数据目录：.rooms/（画布 SQLite）  .assets/（图片/视频）`)
  if (!IS_PROD) {
    console.log(`   前端开发：请同时运行 npm run dev:client  →  http://localhost:5757`)
  }
})
