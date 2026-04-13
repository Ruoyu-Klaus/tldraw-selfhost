/**
 * tldraw Selfhost — MCP Server
 *
 * 运行方式：npm run mcp
 * 配置方式：~/.copilot/mcp-config.json 或 Claude Desktop 配置文件
 *
 * 环境变量：
 *   MCP_TOKEN        鉴权 Token，需与 Fastify 服务端保持一致
 *   TLDRAW_BASE_URL  tldraw Fastify 服务地址（默认 http://localhost:5858）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WebSocket } from 'ws'
import { z } from 'zod'
import type { McpAction, McpRequest, McpResponse } from '../server/mcp-bridge'

// ── 配置 ──────────────────────────────────────────────────────────────────────

const BASE_URL = (process.env.TLDRAW_BASE_URL ?? 'http://localhost:5858').replace(/\/$/, '')
const TOKEN = process.env.MCP_TOKEN ?? ''
const WS_BASE = BASE_URL.replace(/^http/, 'ws')

// Cloudflare Zero Trust Service Token（外网访问时需要）
const CF_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID ?? ''
const CF_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET ?? ''

if (!TOKEN) {
  process.stderr.write('[tldraw-mcp] 警告: MCP_TOKEN 未设置，连接会被服务端拒绝\n')
}
if (BASE_URL !== 'http://localhost:5858' && (!CF_CLIENT_ID || !CF_CLIENT_SECRET)) {
  process.stderr.write('[tldraw-mcp] 警告: 外网模式建议设置 CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET\n')
}

// ── WebSocket 请求转发 ────────────────────────────────────────────────────────

let wsCache: Map<string, WebSocket> = new Map()

function getWs(roomId: string): Promise<WebSocket> {
  const existing = wsCache.get(roomId)
  if (existing && existing.readyState === WebSocket.OPEN) {
    return Promise.resolve(existing)
  }

  return new Promise((resolve, reject) => {
    const url = `${WS_BASE}/mcp-bridge?role=mcp&token=${encodeURIComponent(TOKEN)}&roomId=${encodeURIComponent(roomId)}`

    // CF Zero Trust Service Token 头（本地开发时为空，外网时必须）
    const cfHeaders: Record<string, string> = {}
    if (CF_CLIENT_ID) cfHeaders['CF-Access-Client-Id'] = CF_CLIENT_ID
    if (CF_CLIENT_SECRET) cfHeaders['CF-Access-Client-Secret'] = CF_CLIENT_SECRET

    const ws = new WebSocket(url, { headers: cfHeaders })

    const timeout = setTimeout(() => {
      ws.terminate()
      reject(new Error(`连接超时: ${url}`))
    }, 8000)

    ws.on('open', () => {
      clearTimeout(timeout)
      wsCache.set(roomId, ws)
      resolve(ws)
    })

    ws.on('close', (code, reason) => {
      wsCache.delete(roomId)
      if (code === 4001) reject(new Error(`鉴权失败：Token 错误 (4001)`))
      if (code === 4002) reject(new Error(`缺少 roomId 参数 (4002)`))
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      wsCache.delete(roomId)
      reject(err)
    })
  })
}

let reqCounter = 0

async function bridgeRequest(roomId: string, action: McpAction, payload?: unknown): Promise<unknown> {
  const ws = await getWs(roomId)
  const id = `mcp-${++reqCounter}`

  const request: McpRequest = { type: 'request', id, action, payload }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`请求超时 (10s): ${action}`))
    }, 10_000)

    function onMessage(raw: Buffer) {
      let msg: McpResponse
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type !== 'response' || msg.id !== id) return

      clearTimeout(timer)
      ws.off('message', onMessage)

      if (msg.ok) resolve(msg.data)
      else reject(new Error(msg.error ?? '浏览器返回错误'))
    }

    ws.on('message', onMessage)
    ws.send(JSON.stringify(request))
  })
}

// ── MCP Server 定义 ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'tldraw-selfhost',
  version: '1.0.0',
})

// ── list_rooms ────────────────────────────────────────────────────────────────

server.tool(
  'list_rooms',
  '列出 tldraw 服务器上所有画布房间（不需要浏览器已打开）',
  {},
  async () => {
    const res = await fetch(`${BASE_URL}/api/rooms`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { rooms } = await res.json() as { rooms: unknown[] }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(rooms, null, 2),
      }],
    }
  }
)

// ── get_context ───────────────────────────────────────────────────────────────

server.tool(
  'get_context',
  '获取浏览器当前激活的 page 信息（roomId、pageId、pageName、pageCount）。需要浏览器已打开该房间。',
  { roomId: z.string().describe('房间 ID') },
  async ({ roomId }) => {
    const data = await bridgeRequest(roomId, 'get_context')
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      }],
    }
  }
)

// ── get_pages ─────────────────────────────────────────────────────────────────

server.tool(
  'get_pages',
  '获取指定房间的所有页面列表（id 和 name）。需要浏览器已打开该房间。',
  { roomId: z.string().describe('房间 ID') },
  async ({ roomId }) => {
    const data = await bridgeRequest(roomId, 'get_pages')
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      }],
    }
  }
)

// ── get_shapes ────────────────────────────────────────────────────────────────

server.tool(
  'get_shapes',
  '获取指定房间、指定页面上的所有图形（id/type/x/y/w/h/text/color）。需要浏览器已打开该房间。',
  {
    roomId: z.string().describe('房间 ID'),
    pageId: z.string().optional().describe('Page ID（不填则取浏览器当前激活 page）'),
  },
  async ({ roomId, pageId }) => {
    const data = await bridgeRequest(roomId, 'get_shapes', { pageId })
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      }],
    }
  }
)

// ── create_shape ──────────────────────────────────────────────────────────────

server.tool(
  'create_shape',
  '在 tldraw 画布上创建图形。支持 geo（矩形/椭圆等）、text、note、arrow。需要浏览器已打开该房间。',
  {
    roomId: z.string().describe('房间 ID'),
    shapeType: z.enum(['geo', 'text', 'note', 'arrow']).describe(
      'geo=几何图形, text=文字, note=便签, arrow=箭头'
    ),
    x: z.number().describe('画布 X 坐标'),
    y: z.number().describe('画布 Y 坐标'),
    w: z.number().optional().describe('宽度（geo/note）'),
    h: z.number().optional().describe('高度（geo/note）'),
    text: z.string().optional().describe('文字内容'),
    color: z.enum([
      'black', 'blue', 'cyan', 'green', 'grey',
      'light-blue', 'light-green', 'light-red', 'light-violet',
      'orange', 'red', 'violet', 'white', 'yellow',
    ]).optional().describe('颜色'),
    geoType: z.enum([
      'rectangle', 'ellipse', 'triangle', 'diamond', 'hexagon', 'cloud', 'star',
    ]).optional().describe('geo 子类型（默认 rectangle）'),
    fill: z.enum(['none', 'semi', 'solid', 'pattern']).optional().describe('填充样式'),
    pageId: z.string().optional().describe('目标 page ID（不填则用当前 page）'),
  },
  async (payload) => {
    const { roomId, ...rest } = payload
    const data = await bridgeRequest(roomId, 'create_shape', rest)
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      }],
    }
  }
)

// ── update_shape ──────────────────────────────────────────────────────────────

server.tool(
  'update_shape',
  '更新画布上已有图形的属性（位置/大小/文字/颜色）。需要浏览器已打开该房间。',
  {
    roomId: z.string().describe('房间 ID'),
    shapeId: z.string().describe('图形 ID（从 get_shapes 获取）'),
    x: z.number().optional().describe('新的 X 坐标'),
    y: z.number().optional().describe('新的 Y 坐标'),
    w: z.number().optional().describe('新的宽度'),
    h: z.number().optional().describe('新的高度'),
    text: z.string().optional().describe('新的文字内容'),
    color: z.enum([
      'black', 'blue', 'cyan', 'green', 'grey',
      'light-blue', 'light-green', 'light-red', 'light-violet',
      'orange', 'red', 'violet', 'white', 'yellow',
    ]).optional().describe('新的颜色'),
  },
  async (payload) => {
    const { roomId, ...rest } = payload
    const data = await bridgeRequest(roomId, 'update_shape', rest)
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      }],
    }
  }
)

// ── delete_shapes ─────────────────────────────────────────────────────────────

server.tool(
  'delete_shapes',
  '删除画布上的一个或多个图形。需要浏览器已打开该房间。',
  {
    roomId: z.string().describe('房间 ID'),
    shapeIds: z.array(z.string()).describe('要删除的图形 ID 列表（从 get_shapes 获取）'),
  },
  async ({ roomId, shapeIds }) => {
    const data = await bridgeRequest(roomId, 'delete_shapes', { shapeIds })
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      }],
    }
  }
)

// ── 启动 ──────────────────────────────────────────────────────────────────────

;(async () => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
})()
