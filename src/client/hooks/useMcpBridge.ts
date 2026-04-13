import { Editor, toRichText } from 'tldraw'
import { useEffect } from 'react'
import type { McpAction, McpRequest, McpResponse, McpContextPush } from '../../server/mcp-bridge'

// ── WebSocket URL 生成 ────────────────────────────────────────────────────────

function getMcpBridgeUri(roomId: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const params = new URLSearchParams({ role: 'browser', roomId })
  return `${protocol}//${location.host}/mcp-bridge?${params}`
}

// ── 请求处理：把 McpRequest 翻译成 editor API 调用 ───────────────────────────

async function handleRequest(editor: Editor, req: McpRequest): Promise<unknown> {
  switch (req.action) {
    case 'get_context': {
      const page = editor.getCurrentPage()
      return {
        pageId: page.id,
        pageName: page.name,
        pageCount: editor.getPages().length,
      }
    }

    case 'get_pages': {
      return editor.getPages().map((p) => ({ id: p.id, name: p.name }))
    }

    case 'get_shapes': {
      const payload = req.payload as { pageId?: string } | undefined
      const pageId = (payload?.pageId ?? editor.getCurrentPageId()) as any
      const shapeIds = editor.getPageShapeIds(pageId)
      const shapes = [...shapeIds].map((id) => editor.getShape(id)!).filter(Boolean)
      return shapes.map((s) => {
        const bounds = editor.getShapePageBounds(s.id)
        const props = s.props as Record<string, unknown>
        return {
          id: s.id,
          type: s.type,
          x: s.x,
          y: s.y,
          rotation: s.rotation,
          w: bounds?.w,
          h: bounds?.h,
          text: 'richText' in props
            ? editor.getShapeUtil(s).getText(s)
            : undefined,
          color: 'color' in props ? props.color : undefined,
          geo: 'geo' in props ? props.geo : undefined,
        }
      })
    }

    case 'create_shape': {
      const p = req.payload as {
        shapeType: string
        x: number
        y: number
        w?: number
        h?: number
        text?: string
        color?: string
        geoType?: string
        fill?: string
        pageId?: string
      }

      // 切换到目标 page（如果指定）
      if (p.pageId && p.pageId !== editor.getCurrentPageId()) {
        editor.setCurrentPage(p.pageId as any)
      }

      const id = `shape:${crypto.randomUUID()}` as any

      if (p.shapeType === 'geo') {
        editor.createShape({
          id,
          type: 'geo',
          x: p.x,
          y: p.y,
          props: {
            geo: (p.geoType ?? 'rectangle') as any,
            w: p.w ?? 160,
            h: p.h ?? 80,
            color: (p.color ?? 'black') as any,
            fill: (p.fill ?? 'none') as any,
            richText: toRichText(p.text ?? ''),
          },
        })
      } else if (p.shapeType === 'text') {
        editor.createShape({
          id,
          type: 'text',
          x: p.x,
          y: p.y,
          props: {
            richText: toRichText(p.text ?? ''),
            color: (p.color ?? 'black') as any,
          },
        })
      } else if (p.shapeType === 'note') {
        editor.createShape({
          id,
          type: 'note',
          x: p.x,
          y: p.y,
          props: {
            richText: toRichText(p.text ?? ''),
            color: (p.color ?? 'yellow') as any,
          },
        })
      } else if (p.shapeType === 'arrow') {
        editor.createShape({
          id,
          type: 'arrow',
          x: p.x,
          y: p.y,
          props: {
            color: (p.color ?? 'black') as any,
          },
        })
      } else {
        throw new Error(`不支持的 shapeType: ${p.shapeType}`)
      }

      return { shapeId: id }
    }

    case 'update_shape': {
      const p = req.payload as {
        shapeId: string
        x?: number
        y?: number
        w?: number
        h?: number
        text?: string
        color?: string
      }

      const shape = editor.getShape(p.shapeId as any)
      if (!shape) throw new Error(`找不到 shape: ${p.shapeId}`)

      const partialProps: Record<string, unknown> = {}
      if (p.color !== undefined) partialProps.color = p.color
      if (p.text !== undefined) partialProps.richText = toRichText(p.text)

      editor.updateShape({
        id: shape.id,
        type: shape.type,
        x: p.x ?? shape.x,
        y: p.y ?? shape.y,
        props: partialProps,
      })

      // 如果指定了 w/h，用 resizeShape
      if (p.w !== undefined || p.h !== undefined) {
        const bounds = editor.getShapePageBounds(shape)
        if (bounds) {
          const targetW = p.w ?? bounds.w
          const targetH = p.h ?? bounds.h
          editor.resizeShape(shape.id, { x: targetW / bounds.w, y: targetH / bounds.h })
        }
      }

      return { ok: true }
    }

    case 'delete_shapes': {
      const p = req.payload as { shapeIds: string[] }
      editor.deleteShapes(p.shapeIds as any[])
      return { ok: true, deleted: p.shapeIds.length }
    }

    default: {
      throw new Error(`未知 action: ${(req as any).action}`)
    }
  }
}

// ── useMcpBridge hook ─────────────────────────────────────────────────────────

export function useMcpBridge(editor: Editor | null, roomId: string) {
  useEffect(() => {
    if (!editor) return
    // editor is non-null from here; rebind for TypeScript narrowing in closures
    const ed = editor
    let ws: WebSocket | null = null
    let destroyed = false

    function connect() {
      if (destroyed) return

      ws = new WebSocket(getMcpBridgeUri(roomId))

      ws.onopen = () => {
        pushContext()
      }

      ws.onmessage = async (event) => {
        let req: McpRequest
        try {
          req = JSON.parse(event.data)
        } catch {
          return
        }
        if (req.type !== 'request') return

        let response: McpResponse
        try {
          const data = await handleRequest(ed, req)
          response = { type: 'response', id: req.id, ok: true, data }
        } catch (err: any) {
          response = { type: 'response', id: req.id, ok: false, error: err.message }
        }

        ws?.send(JSON.stringify(response))
      }

      ws.onclose = () => {
        if (destroyed) return
        // 断线后 3 秒重连
        setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        // onclose 会紧跟触发，在那里处理重连
      }
    }

    function pushContext() {
      if (ws?.readyState !== WebSocket.OPEN) return
      const page = ed.getCurrentPage()
      const ctx: McpContextPush = {
        type: 'context',
        roomId,
        pageId: page.id,
        pageName: page.name,
        pageCount: ed.getPages().length,
      }
      ws.send(JSON.stringify(ctx))
    }

    connect()

    // 当用户切换 page 时，主动上报新的 context
    const unsubscribe = ed.store.listen(
      () => pushContext(),
      { scope: 'session' }
    )

    return () => {
      destroyed = true
      unsubscribe()
      ws?.close()
    }
  }, [editor, roomId])
}
