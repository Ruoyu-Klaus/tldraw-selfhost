import type { WebSocket } from 'ws'

// ── 消息类型定义 ──────────────────────────────────────────────────────────────

/** MCP Server → Browser：操作请求 */
export interface McpRequest {
  type: 'request'
  id: string
  action: McpAction
  payload?: unknown
}

export type McpAction =
  | 'get_context'
  | 'get_shapes'
  | 'get_pages'
  | 'create_shape'
  | 'update_shape'
  | 'delete_shapes'

/** Browser → MCP Server：操作响应 */
export interface McpResponse {
  type: 'response'
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

/** Browser → Fastify：主动上报当前 room/page 状态 */
export interface McpContextPush {
  type: 'context'
  roomId: string
  pageId: string
  pageName: string
  pageCount: number
}

type IncomingBrowserMessage = McpResponse | McpContextPush

// ── 每个房间的 Bridge 状态 ────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface BridgeRoom {
  /** 浏览器端 WebSocket（tldraw editor 所在的 tab） */
  browserSocket: WebSocket | null
  /** MCP Server 端 WebSocket（一个 room 同时只有一个 MCP 连接） */
  mcpSocket: WebSocket | null
  /** 浏览器最后上报的 context（room/page 信息） */
  context: Omit<McpContextPush, 'type'> | null
  /** 等待浏览器响应的请求队列，key = request.id */
  pending: Map<string, PendingRequest>
}

// ── McpBridgeManager ──────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000

class McpBridgeManager {
  private rooms = new Map<string, BridgeRoom>()

  private getOrCreateRoom(roomId: string): BridgeRoom {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        browserSocket: null,
        mcpSocket: null,
        context: null,
        pending: new Map(),
      })
    }
    return this.rooms.get(roomId)!
  }

  // ── 注册浏览器客户端 ──────────────────────────────────────────────────────

  registerBrowser(roomId: string, socket: WebSocket) {
    const room = this.getOrCreateRoom(roomId)

    // 同一个 room 只保留最新的浏览器连接
    if (room.browserSocket && room.browserSocket.readyState === 1 /* OPEN */) {
      room.browserSocket.close(1001, 'replaced by newer browser client')
    }
    room.browserSocket = socket

    console.log(`[mcp-bridge] 浏览器连接 room=${roomId}`)

    socket.on('message', (raw) => {
      let msg: IncomingBrowserMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (msg.type === 'context') {
        // 缓存浏览器上报的 room/page context
        room.context = {
          roomId: msg.roomId,
          pageId: msg.pageId,
          pageName: msg.pageName,
          pageCount: msg.pageCount,
        }
        return
      }

      if (msg.type === 'response') {
        // 找到对应的 pending request 并 resolve
        const pending = room.pending.get(msg.id)
        if (!pending) return

        clearTimeout(pending.timer)
        room.pending.delete(msg.id)

        if (msg.ok) {
          pending.resolve(msg.data)
        } else {
          pending.reject(new Error(msg.error ?? 'Browser returned error'))
        }
      }
    })

    socket.on('close', () => {
      console.log(`[mcp-bridge] 浏览器断开 room=${roomId}`)
      if (room.browserSocket === socket) {
        room.browserSocket = null
      }
      this.cleanupRoomIfEmpty(roomId)
    })

    socket.on('error', (err) => {
      console.warn(`[mcp-bridge] 浏览器 socket 错误 room=${roomId}`, err.message)
    })
  }

  // ── 注册 MCP Server 客户端 ────────────────────────────────────────────────

  registerMcp(roomId: string, socket: WebSocket) {
    const room = this.getOrCreateRoom(roomId)

    if (room.mcpSocket && room.mcpSocket.readyState === 1) {
      room.mcpSocket.close(1001, 'replaced by newer mcp client')
    }
    room.mcpSocket = socket

    console.log(`[mcp-bridge] MCP Server 连接 room=${roomId}`)

    socket.on('close', () => {
      console.log(`[mcp-bridge] MCP Server 断开 room=${roomId}`)
      if (room.mcpSocket === socket) {
        room.mcpSocket = null
      }
      this.cleanupRoomIfEmpty(roomId)
    })

    socket.on('error', (err) => {
      console.warn(`[mcp-bridge] MCP socket 错误 room=${roomId}`, err.message)
    })
  }

  // ── 向浏览器发送请求并等待响应 ────────────────────────────────────────────

  forward(roomId: string, request: McpRequest): Promise<unknown> {
    const room = this.rooms.get(roomId)

    if (!room?.browserSocket || room.browserSocket.readyState !== 1) {
      return Promise.reject(
        new Error(`room "${roomId}" 没有浏览器客户端连接，请先在浏览器中打开该房间`)
      )
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        room.pending.delete(request.id)
        reject(new Error(`请求超时（${REQUEST_TIMEOUT_MS}ms）: ${request.action}`))
      }, REQUEST_TIMEOUT_MS)

      room.pending.set(request.id, { resolve, reject, timer })
      room.browserSocket!.send(JSON.stringify(request))
    })
  }

  // ── 获取浏览器上报的 context ──────────────────────────────────────────────

  getContext(roomId: string) {
    return this.rooms.get(roomId)?.context ?? null
  }

  // ── 判断 room 是否有浏览器连接 ───────────────────────────────────────────

  hasBrowser(roomId: string): boolean {
    const room = this.rooms.get(roomId)
    return !!room?.browserSocket && room.browserSocket.readyState === 1
  }

  // ── 内部清理 ──────────────────────────────────────────────────────────────

  private cleanupRoomIfEmpty(roomId: string) {
    const room = this.rooms.get(roomId)
    if (!room) return
    if (!room.browserSocket && !room.mcpSocket && room.pending.size === 0) {
      this.rooms.delete(roomId)
    }
  }
}

// 单例：整个 Fastify 进程共享同一个 Bridge 实例
export const mcpBridge = new McpBridgeManager()
