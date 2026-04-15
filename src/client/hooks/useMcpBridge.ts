import { Editor, compressLegacySegments, getIndices, toRichText } from 'tldraw'
import { useEffect } from 'react'
import type { McpAction, McpRequest, McpResponse, McpContextPush } from '../../server/mcp-bridge'

// --- WebSocket URL -----------------------------------------------------------

function getMcpBridgeUri(roomId: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const params = new URLSearchParams({ role: 'browser', roomId })
  return `${protocol}//${location.host}/mcp-bridge?${params}`
}

function resolveShapes(editor: Editor, shapeIds: string[]) {
  const shapes = shapeIds.map((id) => editor.getShape(id as any)).filter(Boolean) as any[]
  if (shapes.length !== shapeIds.length) {
    const missing = shapeIds.filter((id) => !editor.getShape(id as any))
    throw new Error(`Unknown shape id(s): ${missing.join(', ')}`)
  }
  return shapes
}

/** Union page bounds of shapes (for layout + arrow nudge). */
function unionPageBounds(editor: Editor, shapes: { id: string }[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of shapes) {
    const b = editor.getShapePageBounds(s.id as any)
    if (!b) continue
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  if (!Number.isFinite(minX)) return null
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  }
}

/**
 * After align/distribute/stack/pack, move arrows that lie entirely inside the pre-layout
 * union of `layoutTargets` by the same centroid delta (keeps connectors on simple vertical stacks).
 */
function translateArrowsInsideLayoutUnion(
  editor: Editor,
  before: { x: number; y: number; w: number; h: number; cx: number; cy: number },
  after: { x: number; y: number; w: number; h: number; cx: number; cy: number }
) {
  const dx = after.cx - before.cx
  const dy = after.cy - before.cy
  if (dx === 0 && dy === 0) return 0
  const pad = 32
  const inUnion = (px: number, py: number) =>
    px >= before.x - pad &&
    px <= before.x + before.w + pad &&
    py >= before.y - pad &&
    py <= before.y + before.h + pad

  const pageId = editor.getCurrentPageId()
  let n = 0
  for (const id of editor.getPageShapeIds(pageId)) {
    const sh = editor.getShape(id as any) as any
    if (!sh || sh.type !== 'arrow') continue
    const pr = sh.props as { start: { x: number; y: number }; end: { x: number; y: number } }
    const sx = sh.x + pr.start.x
    const sy = sh.y + pr.start.y
    const ex = sh.x + pr.end.x
    const ey = sh.y + pr.end.y
    if (!inUnion(sx, sy) || !inUnion(ex, ey)) continue
    editor.updateShape({
      id: sh.id,
      type: 'arrow',
      x: sh.x + dx,
      y: sh.y + dy,
      props: sh.props,
    } as any)
    n++
  }
  return n
}

const LAYOUT_EXCLUDED_TYPES = new Set(['arrow', 'line', 'highlight'])

// --- Handle MCP requests → Editor API --------------------------------------

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
        const row: Record<string, unknown> = {
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
        if (s.type === 'geo' || s.type === 'text' || s.type === 'note') {
          if ('dash' in props) row.dash = props.dash
          if ('size' in props) row.size = props.size
          if ('font' in props) row.font = props.font
          if ('align' in props) row.align = props.align
          if ('verticalAlign' in props) row.verticalAlign = props.verticalAlign
          if ('textAlign' in props) row.textAlign = props.textAlign
        }
        if (s.type === 'arrow') {
          const st = props.start as { x: number; y: number } | undefined
          const en = props.end as { x: number; y: number } | undefined
          if (st && en) {
            row.startPageX = s.x + st.x
            row.startPageY = s.y + st.y
            row.endPageX = s.x + en.x
            row.endPageY = s.y + en.y
          }
          if ('kind' in props) row.kind = props.kind
          if ('bend' in props) row.bend = props.bend
          if ('dash' in props) row.dash = props.dash
          if ('size' in props) row.size = props.size
          if ('arrowheadStart' in props) row.arrowheadStart = props.arrowheadStart
          if ('arrowheadEnd' in props) row.arrowheadEnd = props.arrowheadEnd
          if ('labelPosition' in props) row.labelPosition = props.labelPosition
          if ('labelColor' in props) row.labelColor = props.labelColor
        }
        if (s.type === 'line') {
          if ('spline' in props) row.spline = props.spline
          if ('dash' in props) row.dash = props.dash
          if ('size' in props) row.size = props.size
        }
        if (s.type === 'highlight') {
          if ('size' in props) row.size = props.size
          if ('isComplete' in props) row.isComplete = props.isComplete
        }
        if (s.type === 'frame') {
          if ('name' in props) row.frameName = props.name
        }
        return row
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
        dash?: string
        size?: string
        font?: string
        align?: string
        verticalAlign?: string
        textAlign?: string
        startX?: number
        startY?: number
        endX?: number
        endY?: number
        bend?: number
        kind?: string
        arrowheadStart?: string
        arrowheadEnd?: string
        labelPosition?: number
        elbowMidPoint?: number
        labelColor?: string
        linePoints?: { x: number; y: number }[]
        highlightPoints?: { x: number; y: number }[]
        spline?: string
      }

      if (p.pageId && p.pageId !== editor.getCurrentPageId()) {
        editor.setCurrentPage(p.pageId as any)
      }

      const id = `shape:${crypto.randomUUID()}` as any

      if (p.shapeType === 'geo') {
        const d = editor.getShapeUtil('geo').getDefaultProps()
        editor.createShape({
          id,
          type: 'geo',
          x: p.x,
          y: p.y,
          props: {
            ...d,
            geo: (p.geoType ?? 'rectangle') as any,
            w: p.w ?? 160,
            h: p.h ?? 80,
            color: (p.color ?? 'black') as any,
            fill: (p.fill ?? 'none') as any,
            richText: toRichText(p.text ?? ''),
            dash: (p.dash ?? d.dash) as any,
            size: (p.size ?? d.size) as any,
            font: (p.font ?? d.font) as any,
            align: (p.align ?? d.align) as any,
            verticalAlign: (p.verticalAlign ?? d.verticalAlign) as any,
          },
        })
      } else if (p.shapeType === 'text') {
        const d = editor.getShapeUtil('text').getDefaultProps()
        editor.createShape({
          id,
          type: 'text',
          x: p.x,
          y: p.y,
          props: {
            ...d,
            richText: toRichText(p.text ?? ''),
            color: (p.color ?? 'black') as any,
            size: (p.size ?? d.size) as any,
            font: (p.font ?? d.font) as any,
            textAlign: (p.textAlign ?? d.textAlign) as any,
          },
        })
      } else if (p.shapeType === 'note') {
        const d = editor.getShapeUtil('note').getDefaultProps()
        editor.createShape({
          id,
          type: 'note',
          x: p.x,
          y: p.y,
          props: {
            ...d,
            richText: toRichText(p.text ?? ''),
            color: (p.color ?? 'yellow') as any,
            size: (p.size ?? d.size) as any,
            font: (p.font ?? d.font) as any,
            align: (p.align ?? d.align) as any,
            verticalAlign: (p.verticalAlign ?? d.verticalAlign) as any,
          },
        })
      } else if (p.shapeType === 'arrow') {
        const sx = p.startX ?? p.x
        const sy = p.startY ?? p.y
        const ex = p.endX
        const ey = p.endY
        if (ex === undefined || ey === undefined) {
          throw new Error('arrow requires endX and endY (page coordinates). Optionally startX/startY; default uses x,y as start.')
        }
        const d = editor.getShapeUtil('arrow').getDefaultProps()
        editor.createShape({
          id,
          type: 'arrow',
          x: sx,
          y: sy,
          props: {
            ...d,
            start: { x: 0, y: 0 },
            end: { x: ex - sx, y: ey - sy },
            color: (p.color ?? d.color) as any,
            labelColor: (p.labelColor ?? d.labelColor) as any,
            fill: (p.fill ?? d.fill) as any,
            dash: (p.dash ?? d.dash) as any,
            size: (p.size ?? d.size) as any,
            font: (p.font ?? d.font) as any,
            kind: (p.kind ?? d.kind) as any,
            bend: p.bend ?? d.bend,
            arrowheadStart: (p.arrowheadStart ?? d.arrowheadStart) as any,
            arrowheadEnd: (p.arrowheadEnd ?? d.arrowheadEnd) as any,
            richText: toRichText(p.text ?? ''),
            labelPosition: p.labelPosition ?? d.labelPosition,
            elbowMidPoint: p.elbowMidPoint ?? d.elbowMidPoint,
            scale: d.scale,
          },
        })
      } else if (p.shapeType === 'line') {
        const pts = p.linePoints
        if (!pts || pts.length < 2) {
          throw new Error('line requires linePoints: at least two {x,y} page coordinates')
        }
        const d = editor.getShapeUtil('line').getDefaultProps()
        const indices = getIndices(pts.length)
        const ox = pts[0].x
        const oy = pts[0].y
        const points: Record<string, { id: string; index: string; x: number; y: number }> = {}
        for (let i = 0; i < pts.length; i++) {
          const idx = indices[i] as string
          points[idx] = {
            id: idx,
            index: idx,
            x: pts[i].x - ox,
            y: pts[i].y - oy,
          }
        }
        editor.createShape({
          id,
          type: 'line',
          x: ox,
          y: oy,
          props: {
            ...d,
            points: points as any,
            color: (p.color ?? d.color) as any,
            dash: (p.dash ?? d.dash) as any,
            size: (p.size ?? d.size) as any,
            spline: (p.spline ?? d.spline) as any,
          },
        })
      } else if (p.shapeType === 'highlight') {
        const pts = p.highlightPoints
        if (!pts || pts.length < 1) {
          throw new Error('highlight requires highlightPoints: at least one {x,y} page coordinate (one = dot, two+ = stroke)')
        }
        const d = editor.getShapeUtil('highlight').getDefaultProps()
        const ox = pts[0].x
        const oy = pts[0].y
        const vecModels = pts.map((pt) => ({ x: pt.x - ox, y: pt.y - oy, z: 0.5 }))
        const segments = compressLegacySegments([{ type: 'free', points: vecModels }])
        editor.createShape({
          id,
          type: 'highlight',
          x: ox,
          y: oy,
          props: {
            ...d,
            segments: segments as any,
            color: (p.color ?? 'yellow') as any,
            size: (p.size ?? d.size) as any,
            isComplete: true,
            isPen: false,
          },
        })
      } else {
        throw new Error(`Unsupported shapeType: ${p.shapeType}`)
      }

      return { shapeId: id }
    }

    case 'create_backdrop': {
      const p = req.payload as {
        shapeIds: string[]
        padding?: number
        color?: string
        fill?: string
        dash?: string
        geoType?: string
        pageId?: string
        deleteBackdropShapeId?: string
      }
      if (!p.shapeIds?.length) {
        throw new Error('create_backdrop requires shapeIds: include every part of the diagram (arrows/lines too)')
      }
      if (p.pageId && p.pageId !== editor.getCurrentPageId()) {
        editor.setCurrentPage(p.pageId as any)
      }
      if (p.deleteBackdropShapeId && editor.getShape(p.deleteBackdropShapeId as any)) {
        editor.deleteShapes([p.deleteBackdropShapeId as any])
      }
      const shapes = resolveShapes(editor, p.shapeIds)
      const u = unionPageBounds(editor, shapes)
      if (!u) {
        throw new Error('Could not compute page bounds for those shapes (missing geometry?)')
      }
      const pad = p.padding ?? 64
      const gx = u.x - pad
      const gy = u.y - pad
      const gw = u.w + pad * 2
      const gh = u.h + pad * 2
      const id = `shape:${crypto.randomUUID()}` as any
      const d = editor.getShapeUtil('geo').getDefaultProps()
      editor.createShape({
        id,
        type: 'geo',
        x: gx,
        y: gy,
        props: {
          ...d,
          geo: (p.geoType ?? 'rectangle') as any,
          w: gw,
          h: gh,
          color: (p.color ?? 'light-violet') as any,
          fill: (p.fill ?? 'semi') as any,
          richText: toRichText(''),
          dash: (p.dash ?? 'dotted') as any,
          size: 's' as any,
          font: d.font,
          align: 'middle' as any,
          verticalAlign: 'middle' as any,
        },
      })
      editor.sendToBack([id] as any)
      return {
        shapeId: id,
        x: gx,
        y: gy,
        w: gw,
        h: gh,
        padding: pad,
        contentUnion: { x: u.x, y: u.y, w: u.w, h: u.h },
      }
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
        dash?: string
        size?: string
        font?: string
        align?: string
        verticalAlign?: string
        textAlign?: string
        startX?: number
        startY?: number
        endX?: number
        endY?: number
        bend?: number
        kind?: string
        arrowheadStart?: string
        arrowheadEnd?: string
        labelPosition?: number
        elbowMidPoint?: number
        labelColor?: string
        fill?: string
        spline?: string
      }

      const shape = editor.getShape(p.shapeId as any)
      if (!shape) throw new Error(`Shape not found: ${p.shapeId}`)

      const partialProps: Record<string, unknown> = {}
      if (p.color !== undefined) partialProps.color = p.color
      if (p.text !== undefined) partialProps.richText = toRichText(p.text)

      const t = shape.type
      if (t === 'geo') {
        if (p.dash !== undefined) partialProps.dash = p.dash
        if (p.size !== undefined) partialProps.size = p.size
        if (p.font !== undefined) partialProps.font = p.font
        if (p.align !== undefined) partialProps.align = p.align
        if (p.verticalAlign !== undefined) partialProps.verticalAlign = p.verticalAlign
      } else if (t === 'text') {
        if (p.size !== undefined) partialProps.size = p.size
        if (p.font !== undefined) partialProps.font = p.font
        if (p.textAlign !== undefined) partialProps.textAlign = p.textAlign
      } else if (t === 'note') {
        if (p.size !== undefined) partialProps.size = p.size
        if (p.font !== undefined) partialProps.font = p.font
        if (p.align !== undefined) partialProps.align = p.align
        if (p.verticalAlign !== undefined) partialProps.verticalAlign = p.verticalAlign
      } else if (t === 'arrow') {
        if (p.dash !== undefined) partialProps.dash = p.dash
        if (p.size !== undefined) partialProps.size = p.size
        if (p.font !== undefined) partialProps.font = p.font
        if (p.fill !== undefined) partialProps.fill = p.fill
        if (p.labelColor !== undefined) partialProps.labelColor = p.labelColor
        if (p.bend !== undefined) partialProps.bend = p.bend
        if (p.kind !== undefined) partialProps.kind = p.kind
        if (p.arrowheadStart !== undefined) partialProps.arrowheadStart = p.arrowheadStart
        if (p.arrowheadEnd !== undefined) partialProps.arrowheadEnd = p.arrowheadEnd
        if (p.labelPosition !== undefined) partialProps.labelPosition = p.labelPosition
        if (p.elbowMidPoint !== undefined) partialProps.elbowMidPoint = p.elbowMidPoint
      } else if (t === 'line') {
        if (p.dash !== undefined) partialProps.dash = p.dash
        if (p.size !== undefined) partialProps.size = p.size
        if (p.spline !== undefined) partialProps.spline = p.spline
      } else if (t === 'highlight') {
        if (p.size !== undefined) partialProps.size = p.size
      }

      let nextX = p.x ?? shape.x
      let nextY = p.y ?? shape.y

      if (t === 'arrow' && p.endX !== undefined && p.endY !== undefined) {
        const sx = p.startX ?? shape.x
        const sy = p.startY ?? shape.y
        nextX = sx
        nextY = sy
        partialProps.start = { x: 0, y: 0 }
        partialProps.end = { x: p.endX - sx, y: p.endY - sy }
      }

      editor.updateShape({
        id: shape.id,
        type: shape.type,
        x: nextX,
        y: nextY,
        props: partialProps,
      })

      if (t !== 'arrow' && t !== 'line' && t !== 'highlight' && (p.w !== undefined || p.h !== undefined)) {
        const bounds = editor.getShapePageBounds(shape)
        if (bounds) {
          const targetW = p.w ?? bounds.w
          const targetH = p.h ?? bounds.h
          editor.resizeShape(shape.id, { x: targetW / bounds.w, y: targetH / bounds.h })
        }
      }

      return { ok: true }
    }

    case 'layout_shapes': {
      const p = req.payload as {
        operation: string
        shapeIds: string[]
        align?: string
        distribute?: string
        stack?: string
        gap?: number
        packGap?: number
      }
      const ids = p.shapeIds
      if (!ids?.length) throw new Error('layout_shapes requires shapeIds')

      const shapes = resolveShapes(editor, ids)
      const layoutTargets = shapes.filter((s) => !LAYOUT_EXCLUDED_TYPES.has(s.type))
      let arrowsNudged = 0

      switch (p.operation) {
        case 'align': {
          if (!p.align) throw new Error('align operation requires align: top|bottom|left|right|center-horizontal|center-vertical')
          if (!layoutTargets.length) {
            throw new Error('align needs at least one non-arrow, non-line shape in shapeIds')
          }
          const before = unionPageBounds(editor, layoutTargets)
          editor.alignShapes(
            layoutTargets,
            p.align as 'bottom' | 'center-horizontal' | 'center-vertical' | 'left' | 'right' | 'top'
          )
          if (before) {
            const after = unionPageBounds(editor, layoutTargets)
            if (after) arrowsNudged = translateArrowsInsideLayoutUnion(editor, before, after)
          }
          break
        }
        case 'distribute': {
          if (!p.distribute) throw new Error('distribute operation requires distribute: horizontal|vertical')
          if (!layoutTargets.length) throw new Error('distribute needs at least one non-arrow, non-line shape')
          const before = unionPageBounds(editor, layoutTargets)
          editor.distributeShapes(layoutTargets, p.distribute as 'horizontal' | 'vertical')
          if (before) {
            const after = unionPageBounds(editor, layoutTargets)
            if (after) arrowsNudged = translateArrowsInsideLayoutUnion(editor, before, after)
          }
          break
        }
        case 'stack': {
          if (!p.stack) throw new Error('stack operation requires stack: horizontal|vertical')
          if (!layoutTargets.length) throw new Error('stack needs at least one non-arrow, non-line shape')
          const before = unionPageBounds(editor, layoutTargets)
          editor.stackShapes(layoutTargets, p.stack as 'horizontal' | 'vertical', p.gap)
          if (before) {
            const after = unionPageBounds(editor, layoutTargets)
            if (after) arrowsNudged = translateArrowsInsideLayoutUnion(editor, before, after)
          }
          break
        }
        case 'pack': {
          if (!layoutTargets.length) throw new Error('pack needs at least one non-arrow, non-line shape')
          const before = unionPageBounds(editor, layoutTargets)
          editor.packShapes(layoutTargets, p.packGap ?? p.gap)
          if (before) {
            const after = unionPageBounds(editor, layoutTargets)
            if (after) arrowsNudged = translateArrowsInsideLayoutUnion(editor, before, after)
          }
          break
        }
        case 'group': {
          if (shapes.length < 2) throw new Error('group requires at least two shapes')
          editor.groupShapes(shapes as any)
          break
        }
        case 'bring_to_front': {
          editor.bringToFront(shapes as any)
          break
        }
        case 'send_to_back': {
          editor.sendToBack(shapes as any)
          break
        }
        default:
          throw new Error(
            `Unknown layout operation: ${p.operation}. Use align|distribute|stack|pack|group|bring_to_front|send_to_back`
          )
      }

      const out: Record<string, unknown> = { ok: true }
      if (arrowsNudged > 0) out.arrowsNudged = arrowsNudged
      return out
    }

    case 'delete_shapes': {
      const p = req.payload as { shapeIds: string[] }
      editor.deleteShapes(p.shapeIds as any[])
      return { ok: true, deleted: p.shapeIds.length }
    }

    default: {
      throw new Error(`Unknown action: ${(req as any).action}`)
    }
  }
}

// --- useMcpBridge hook --------------------------------------------------------

export function useMcpBridge(editor: Editor | null, roomId: string) {
  useEffect(() => {
    if (!editor) return
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
        setTimeout(connect, 3000)
      }

      ws.onerror = () => {}
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
