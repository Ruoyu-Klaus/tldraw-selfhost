import type { WebSocket } from 'ws'

// --- Message types -----------------------------------------------------------

/** MCP server → browser: operation request */
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
  | 'create_backdrop'
  | 'update_shape'
  | 'delete_shapes'
  | 'layout_shapes'

/** Browser → MCP server: operation response */
export interface McpResponse {
  type: 'response'
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

/** Browser → Fastify: push current room / page context */
export interface McpContextPush {
  type: 'context'
  roomId: string
  pageId: string
  pageName: string
  pageCount: number
}

type IncomingBrowserMessage = McpResponse | McpContextPush

// --- Per-room bridge state ---------------------------------------------------

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface BridgeRoom {
  /** Browser WebSocket (tab running the tldraw editor) */
  browserSocket: WebSocket | null
  /** MCP server WebSocket (one active MCP connection per room) */
  mcpSocket: WebSocket | null
  /** Last context pushed from the browser */
  context: Omit<McpContextPush, 'type'> | null
  /** Pending requests awaiting browser response, keyed by request id */
  pending: Map<string, PendingRequest>
}

// --- McpBridgeManager --------------------------------------------------------

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

  // --- Register browser client ---------------------------------------------

  registerBrowser(roomId: string, socket: WebSocket) {
    const room = this.getOrCreateRoom(roomId)

    // Keep only the newest browser connection per room
    if (room.browserSocket && room.browserSocket.readyState === 1 /* OPEN */) {
      room.browserSocket.close(1001, 'replaced by newer browser client')
    }
    room.browserSocket = socket

    console.log(`[mcp-bridge] browser connected room=${roomId}`)

    socket.on('message', (raw) => {
      let msg: IncomingBrowserMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (msg.type === 'context') {
        room.context = {
          roomId: msg.roomId,
          pageId: msg.pageId,
          pageName: msg.pageName,
          pageCount: msg.pageCount,
        }
        return
      }

      if (msg.type === 'response') {
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
      console.log(`[mcp-bridge] browser disconnected room=${roomId}`)
      if (room.browserSocket === socket) {
        room.browserSocket = null
      }
      this.cleanupRoomIfEmpty(roomId)
    })

    socket.on('error', (err) => {
      console.warn(`[mcp-bridge] browser socket error room=${roomId}`, err.message)
    })
  }

  // --- Register MCP server client ------------------------------------------

  registerMcp(roomId: string, socket: WebSocket) {
    const room = this.getOrCreateRoom(roomId)

    if (room.mcpSocket && room.mcpSocket.readyState === 1) {
      room.mcpSocket.close(1001, 'replaced by newer mcp client')
    }
    room.mcpSocket = socket

    console.log(`[mcp-bridge] MCP server connected room=${roomId}`)

    // Forward MCP → browser; browser response goes back to MCP
    socket.on('message', (raw) => {
      let req: McpRequest
      try {
        req = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (req.type !== 'request') return

      const browser = room.browserSocket
      if (!browser || browser.readyState !== 1) {
        const errResp: McpResponse = {
          type: 'response',
          id: req.id,
          ok: false,
          error: `room "${roomId}" has no browser client; open this room in the browser first`,
        }
        socket.send(JSON.stringify(errResp))
        return
      }

      const onBrowserMessage = (browserRaw: Buffer) => {
        let resp: McpResponse
        try {
          resp = JSON.parse(browserRaw.toString())
        } catch {
          return
        }
        if (resp.type !== 'response' || resp.id !== req.id) return

        browser.off('message', onBrowserMessage)
        clearTimeout(timer)
        if (socket.readyState === 1) socket.send(JSON.stringify(resp))
      }

      const timer = setTimeout(() => {
        browser.off('message', onBrowserMessage)
        const errResp: McpResponse = {
          type: 'response',
          id: req.id,
          ok: false,
          error: `Request timeout (10s): ${req.action}`,
        }
        if (socket.readyState === 1) socket.send(JSON.stringify(errResp))
      }, 10_000)

      browser.on('message', onBrowserMessage)
      browser.send(JSON.stringify(req))
    })

    socket.on('close', () => {
      console.log(`[mcp-bridge] MCP server disconnected room=${roomId}`)
      if (room.mcpSocket === socket) {
        room.mcpSocket = null
      }
      this.cleanupRoomIfEmpty(roomId)
    })

    socket.on('error', (err) => {
      console.warn(`[mcp-bridge] MCP socket error room=${roomId}`, err.message)
    })
  }

  // --- Forward request to browser and await response -----------------------

  forward(roomId: string, request: McpRequest): Promise<unknown> {
    const room = this.rooms.get(roomId)

    if (!room?.browserSocket || room.browserSocket.readyState !== 1) {
      return Promise.reject(
        new Error(`room "${roomId}" has no browser client; open this room in the browser first`)
      )
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        room.pending.delete(request.id)
        reject(new Error(`Request timeout (${REQUEST_TIMEOUT_MS}ms): ${request.action}`))
      }, REQUEST_TIMEOUT_MS)

      room.pending.set(request.id, { resolve, reject, timer })
      room.browserSocket!.send(JSON.stringify(request))
    })
  }

  // --- Last pushed context ---------------------------------------------------

  getContext(roomId: string) {
    return this.rooms.get(roomId)?.context ?? null
  }

  // --- Browser connected? ----------------------------------------------------

  hasBrowser(roomId: string): boolean {
    const room = this.rooms.get(roomId)
    return !!room?.browserSocket && room.browserSocket.readyState === 1
  }

  // --- Internal cleanup ------------------------------------------------------

  private cleanupRoomIfEmpty(roomId: string) {
    const room = this.rooms.get(roomId)
    if (!room) return
    if (!room.browserSocket && !room.mcpSocket && room.pending.size === 0) {
      this.rooms.delete(roomId)
    }
  }
}

/** Singleton shared by the Fastify process */
export const mcpBridge = new McpBridgeManager()
