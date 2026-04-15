/**
 * tldraw Selfhost — MCP Server (distributable standalone package)
 *
 * Usage:
 *   npx -y https://github.com/OWNER/REPO/releases/download/vX.Y.Z/tldraw-selfhost-mcp-X.Y.Z.tgz
 *
 * Environment:
 *   TLDRAW_BASE_URL          tldraw Fastify base URL (default http://localhost:5858)
 *   MCP_TOKEN                Auth token; must match server
 *   CF_ACCESS_CLIENT_ID      Cloudflare Access service token ID (required when exposed publicly)
 *   CF_ACCESS_CLIENT_SECRET  Cloudflare Access service token secret
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WebSocket } from 'ws'
import { z } from 'zod'
import type { McpAction, McpRequest, McpResponse } from './types'

// --- Config -----------------------------------------------------------------

const BASE_URL = (process.env.TLDRAW_BASE_URL ?? 'http://localhost:5858').replace(/\/$/, '')
const TOKEN = process.env.MCP_TOKEN ?? ''
const WS_BASE = BASE_URL.replace(/^http/, 'ws')

const CF_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID ?? ''
const CF_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET ?? ''

if (!TOKEN) {
  process.stderr.write('[tldraw-mcp] warning: MCP_TOKEN is unset; server will reject connections\n')
}
if (BASE_URL !== 'http://localhost:5858' && (!CF_CLIENT_ID || !CF_CLIENT_SECRET)) {
  process.stderr.write(
    '[tldraw-mcp] warning: public URL mode — set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET\n'
  )
}

// --- WebSocket bridge ---------------------------------------------------------

const wsCache: Map<string, WebSocket> = new Map()

function getWs(roomId: string): Promise<WebSocket> {
  const existing = wsCache.get(roomId)
  if (existing && existing.readyState === WebSocket.OPEN) {
    return Promise.resolve(existing)
  }

  return new Promise((resolve, reject) => {
    const url = `${WS_BASE}/mcp-bridge?role=mcp&token=${encodeURIComponent(TOKEN)}&roomId=${encodeURIComponent(roomId)}`

    const cfHeaders: Record<string, string> = {}
    if (CF_CLIENT_ID) cfHeaders['CF-Access-Client-Id'] = CF_CLIENT_ID
    if (CF_CLIENT_SECRET) cfHeaders['CF-Access-Client-Secret'] = CF_CLIENT_SECRET

    const ws = new WebSocket(url, { headers: cfHeaders })

    const timeout = setTimeout(() => {
      ws.terminate()
      reject(new Error(`WebSocket connect timeout: ${url}`))
    }, 8000)

    ws.on('open', () => {
      clearTimeout(timeout)
      wsCache.set(roomId, ws)
      resolve(ws)
    })

    ws.on('close', (code) => {
      wsCache.delete(roomId)
      if (code === 4001) reject(new Error('Auth failed: invalid token (4001)'))
      if (code === 4002) reject(new Error('Missing roomId query (4002)'))
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
      reject(new Error(`Request timeout (10s): ${action}`))
    }, 10_000)

    function onMessage(raw: Buffer) {
      let msg: McpResponse
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type !== 'response' || msg.id !== id) return

      clearTimeout(timer)
      ws.off('message', onMessage)

      if (msg.ok) resolve(msg.data)
      else reject(new Error(msg.error ?? 'Browser returned an error'))
    }

    ws.on('message', onMessage)
    ws.send(JSON.stringify(request))
  })
}

// --- Style enums (aligned with @tldraw/tlschema for geo / text / note) -----

const zDash = z.enum(['solid', 'dashed', 'dotted', 'draw'])
const zSize = z.enum(['s', 'm', 'l', 'xl'])
const zFont = z.enum(['draw', 'sans', 'serif', 'mono'])
const zAlignH = z.enum(['start', 'middle', 'end'])
const zVerticalAlign = z.enum(['start', 'middle', 'end'])

const stylePropsCreate = {
  dash: zDash.optional().describe('Geo only: outline dash style'),
  size: zSize.optional().describe('Geo / text / note: stroke or text size token'),
  font: zFont.optional().describe('Geo / text / note: font style'),
  align: zAlignH.optional().describe('Geo / note horizontal text align (use textAlign for text shapes)'),
  verticalAlign: zVerticalAlign.optional().describe('Geo / note: vertical text align'),
  textAlign: zAlignH.optional().describe('Text only: horizontal align'),
}

const stylePropsUpdate = {
  dash: zDash.optional().describe('Geo only'),
  size: zSize.optional(),
  font: zFont.optional(),
  align: zAlignH.optional().describe('Geo / note only'),
  verticalAlign: zVerticalAlign.optional().describe('Geo / note only'),
  textAlign: zAlignH.optional().describe('Text only'),
}

const zArrowKind = z.enum(['arc', 'elbow'])
const zArrowhead = z.enum([
  'arrow',
  'bar',
  'diamond',
  'dot',
  'inverted',
  'none',
  'pipe',
  'square',
  'triangle',
])
const zSpline = z.enum(['line', 'cubic'])
const zLayoutOp = z.enum([
  'align',
  'distribute',
  'stack',
  'pack',
  'group',
  'bring_to_front',
  'send_to_back',
])
const zAlignShapes = z.enum([
  'top',
  'bottom',
  'left',
  'right',
  'center-horizontal',
  'center-vertical',
])

const arrowPropsCreate = {
  startX: z.number().optional().describe('Arrow: page X of tail (default: x)'),
  startY: z.number().optional().describe('Arrow: page Y of tail (default: y)'),
  endX: z.number().optional().describe('Arrow: page X of head (required for arrow)'),
  endY: z.number().optional().describe('Arrow: page Y of head (required for arrow)'),
  bend: z.number().optional().describe('Arrow: bend (-1..1 style curve)'),
  kind: zArrowKind.optional().describe('Arrow: arc | elbow'),
  arrowheadStart: zArrowhead.optional(),
  arrowheadEnd: zArrowhead.optional(),
  labelPosition: z.number().optional().describe('Arrow: label position along shaft 0..1'),
  elbowMidPoint: z.number().optional().describe('Arrow: elbow midpoint (elbow kind)'),
  labelColor: z
    .enum([
      'black',
      'blue',
      'cyan',
      'green',
      'grey',
      'light-blue',
      'light-green',
      'light-red',
      'light-violet',
      'orange',
      'red',
      'violet',
      'white',
      'yellow',
    ])
    .optional()
    .describe('Arrow label color'),
}

const arrowPropsUpdate = {
  startX: z.number().optional().describe('Arrow: new tail page X (use with endX/endY/startY)'),
  startY: z.number().optional().describe('Arrow: new tail page Y'),
  endX: z.number().optional().describe('Arrow: new head page X'),
  endY: z.number().optional().describe('Arrow: new head page Y'),
  bend: z.number().optional(),
  kind: zArrowKind.optional(),
  arrowheadStart: zArrowhead.optional(),
  arrowheadEnd: zArrowhead.optional(),
  labelPosition: z.number().optional(),
  elbowMidPoint: z.number().optional(),
  labelColor: arrowPropsCreate.labelColor,
  fill: z.enum(['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill']).optional().describe('Arrow fill'),
  spline: zSpline.optional().describe('Line: spline style'),
}

// --- MCP server ---------------------------------------------------------------

const server = new McpServer({
  name: 'tldraw-selfhost',
  version: '1.0.0',
})

server.tool(
  'list_rooms',
  'List all canvas rooms on the tldraw server (no browser required).',
  {},
  async () => {
    const res = await fetch(`${BASE_URL}/api/rooms`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { rooms } = (await res.json()) as { rooms: unknown[] }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rooms, null, 2) }],
    }
  }
)

server.tool(
  'get_context',
  'Get active page info from the browser (pageId, pageName, pageCount). Requires a browser tab open for this room.',
  { roomId: z.string().describe('Room ID') },
  async ({ roomId }) => {
    const data = await bridgeRequest(roomId, 'get_context')
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    }
  }
)

server.tool(
  'get_pages',
  'List all pages (id and name) for the room. Requires a browser tab open for this room.',
  { roomId: z.string().describe('Room ID') },
  async ({ roomId }) => {
    const data = await bridgeRequest(roomId, 'get_pages')
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    }
  }
)

server.tool(
  'get_shapes',
  'List shapes on a page (geo/text/note; arrow endpoints; line; highlight size/complete; legacy frame name if present). Browser tab required.',
  {
    roomId: z.string().describe('Room ID'),
    pageId: z.string().optional().describe('Page ID (omit to use the active page in the browser)'),
  },
  async ({ roomId, pageId }) => {
    const data = await bridgeRequest(roomId, 'get_shapes', { pageId })
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    }
  }
)

server.tool(
  'create_shape',
  'Create geo, text, note, arrow, line, or highlight. Arrow: endX/endY page coords; line: linePoints; highlight: highlightPoints. For a semi backdrop that wraps everything, use create_backdrop after placing shapes (do not guess a huge geo). Browser tab required.',
  {
    roomId: z.string().describe('Room ID'),
    shapeType: z
      .enum(['geo', 'text', 'note', 'arrow', 'line', 'highlight'])
      .describe('geo | text | note | arrow | line | highlight'),
    x: z.number().describe('Canvas X (or arrow tail default)'),
    y: z.number().describe('Canvas Y (or arrow tail default)'),
    w: z.number().optional().describe('Width (geo / note)'),
    h: z.number().optional().describe('Height (geo / note)'),
    text: z.string().optional().describe('Text or arrow label'),
    color: z
      .enum([
        'black',
        'blue',
        'cyan',
        'green',
        'grey',
        'light-blue',
        'light-green',
        'light-red',
        'light-violet',
        'orange',
        'red',
        'violet',
        'white',
        'yellow',
      ])
      .optional()
      .describe('Color'),
    geoType: z
      .enum(['rectangle', 'ellipse', 'triangle', 'diamond', 'hexagon', 'cloud', 'star'])
      .optional()
      .describe('Geo variant (default rectangle)'),
    fill: z
      .enum(['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill'])
      .optional()
      .describe('Fill (geo / arrow)'),
    pageId: z.string().optional().describe('Target page ID (omit for current page)'),
    linePoints: z
      .array(z.object({ x: z.number(), y: z.number() }))
      .min(2)
      .optional()
      .describe('Line: polyline vertices in page coordinates'),
    highlightPoints: z
      .array(z.object({ x: z.number(), y: z.number() }))
      .min(1)
      .optional()
      .describe('Highlight: stroke path in page coordinates (required when shapeType=highlight)'),
    spline: zSpline.optional().describe('Line: line (polyline) or cubic (smooth)'),
    ...stylePropsCreate,
    ...arrowPropsCreate,
  },
  async (payload) => {
    const { roomId, ...rest } = payload
    const data = await bridgeRequest(roomId, 'create_shape', rest)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    }
  }
)

server.tool(
  'create_backdrop',
  'Create one geo rectangle from the page union of shapeIds plus padding (default 64px), empty fill style, sendToBack. Include boxes, notes, text, arrows, lines, highlights so the frame matches real extent. Optional deleteBackdropShapeId removes a previous backdrop geo first. Browser tab required.',
  {
    roomId: z.string().describe('Room ID'),
    shapeIds: z
      .array(z.string())
      .min(1)
      .describe('All diagram shapes to wrap (include arrows/lines so bounds are wide enough)'),
    padding: z
      .number()
      .optional()
      .describe('Extra margin around union bounds in px (default 64; use 96+ if labels stick out)'),
    color: z
      .enum([
        'black',
        'blue',
        'cyan',
        'green',
        'grey',
        'light-blue',
        'light-green',
        'light-red',
        'light-violet',
        'orange',
        'red',
        'violet',
        'white',
        'yellow',
      ])
      .optional()
      .describe('Geo outline/fill tint (default light-violet)'),
    fill: z
      .enum(['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill'])
      .optional()
      .describe('Default semi'),
    dash: zDash.optional().describe('Default dotted'),
    geoType: z
      .enum(['rectangle', 'ellipse', 'triangle', 'diamond', 'hexagon', 'cloud', 'star'])
      .optional()
      .describe('Default rectangle'),
    pageId: z.string().optional().describe('Target page (omit for current)'),
    deleteBackdropShapeId: z
      .string()
      .optional()
      .describe('If set, delete this shape id first (e.g. old backdrop geo)'),
  },
  async (payload) => {
    const { roomId, ...rest } = payload
    const data = await bridgeRequest(roomId, 'create_backdrop', rest)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    }
  }
)

server.tool(
  'update_shape',
  'Update shape geometry/style. Arrow: page endpoints + style. Line: dash/size/spline. Highlight: color/size/position. Geo/text/note as before. Browser tab required.',
  {
    roomId: z.string().describe('Room ID'),
    shapeId: z.string().describe('Shape ID (from get_shapes)'),
    x: z.number().optional().describe('New X'),
    y: z.number().optional().describe('New Y'),
    w: z.number().optional().describe('New width (resize; not used for arrow endpoints)'),
    h: z.number().optional().describe('New height'),
    text: z.string().optional().describe('New text or arrow label'),
    color: z
      .enum([
        'black',
        'blue',
        'cyan',
        'green',
        'grey',
        'light-blue',
        'light-green',
        'light-red',
        'light-violet',
        'orange',
        'red',
        'violet',
        'white',
        'yellow',
      ])
      .optional()
      .describe('New color'),
    ...stylePropsUpdate,
    ...arrowPropsUpdate,
  },
  async (payload) => {
    const { roomId, ...rest } = payload
    const data = await bridgeRequest(roomId, 'update_shape', rest)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    }
  }
)

server.tool(
  'delete_shapes',
  'Delete one or more shapes by ID. Requires a browser tab open for this room.',
  {
    roomId: z.string().describe('Room ID'),
    shapeIds: z.array(z.string()).describe('Shape IDs to delete (from get_shapes)'),
  },
  async ({ roomId, shapeIds }) => {
    const data = await bridgeRequest(roomId, 'delete_shapes', { shapeIds })
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    }
  }
)

server.tool(
  'layout_shapes',
  'Layout: align, distribute, stack, pack, group, z-order. align/distribute/stack/pack ignore arrow/line ids and nudge arrows fully inside the layout block. Browser tab required.',
  {
    roomId: z.string().describe('Room ID'),
    operation: zLayoutOp.describe(
      'align | distribute | stack | pack | group | bring_to_front | send_to_back'
    ),
    shapeIds: z.array(z.string()).min(1).describe('Shapes to affect (order may matter for pack/stack)'),
    align: zAlignShapes
      .optional()
      .describe('Required when operation=align: which edge or center to align'),
    distribute: z
      .enum(['horizontal', 'vertical'])
      .optional()
      .describe('Required when operation=distribute'),
    stack: z
      .enum(['horizontal', 'vertical'])
      .optional()
      .describe('Required when operation=stack'),
    gap: z.number().optional().describe('Gap for stack (optional; editor default if omitted)'),
    packGap: z.number().optional().describe('Padding for pack (optional)'),
  },
  async (payload) => {
    const { roomId, ...rest } = payload
    const data = await bridgeRequest(roomId, 'layout_shapes', rest)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    }
  }
)

// --- Boot ---------------------------------------------------------------------

;(async () => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
})()
