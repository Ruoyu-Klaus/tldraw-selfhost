# tldraw Selfhost — MCP Server 集成方案

> **目标**：为现有的 tldraw selfhost 服务接入 MCP（Model Context Protocol）支持，让 GitHub Copilot CLI、Claude Desktop、Cursor 等已付费 AI agent 直接操作画布，无需额外的 LLM API Key。

---

## 目录

1. [整体架构](#1-整体架构)
2. [鉴权设计](#2-鉴权设计)
3. [数据流详解](#3-数据流详解)
4. [WebSocket 消息协议](#4-websocket-消息协议)
5. [MCP Tools 定义](#5-mcp-tools-定义)
6. [文件结构与改动清单](#6-文件结构与改动清单)
7. [环境变量](#7-环境变量)
8. [接入各 AI 客户端的配置](#8-接入各-ai-客户端的配置)
9. [实现步骤](#9-实现步骤)

---

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│             Copilot CLI / Claude Desktop / Cursor            │
└─────────────────────┬───────────────────────────────────────┘
                      │  MCP Protocol（stdio / SSE）
┌─────────────────────▼───────────────────────────────────────┐
│                MCP Server（新增，独立进程）                    │
│  src/mcp/server.ts                                           │
│  工具：list_rooms · get_context · get_shapes                 │
│        create_shape · update_shape · delete_shapes           │
└─────────────────────┬───────────────────────────────────────┘
                      │  WebSocket + Bearer Token
                      │  ws://localhost:5858/mcp-bridge?token=xxx&roomId=yyy
┌─────────────────────▼───────────────────────────────────────┐
│         Fastify Server（现有，port 5858，新增端点）            │
│  新增：GET  /mcp-bridge（WebSocket，鉴权）                    │
│  现有：GET  /connect/:roomId（tldraw sync WS）               │
│  现有：GET  /api/rooms                                        │
└──────────┬──────────────────────────────────────────────────┘
           │  WebSocket（现有 tldraw sync 协议）
┌──────────▼──────────────────────────────────────────────────┐
│              Browser（tldraw editor）                         │
│  新增：useMcpBridge hook                                      │
│    ┣ 连接 /mcp-bridge，上报当前 roomId + pageId              │
│    ┣ 接收 MCP 指令 → 调用 editor API 执行                    │
│    ┗ 将执行结果/画布状态回传给 MCP Server                     │
└─────────────────────────────────────────────────────────────┘
```

### 为什么选 WebSocket Bridge 而非直接操作 SQLite

| 方案 | 优点 | 缺点 |
|------|------|------|
| **WS Bridge**（本方案）| 操作经过 tldraw editor，数据格式正确，多客户端自动同步 | 需要浏览器已打开对应房间 |
| 直接读写 SQLite | 无需浏览器 | tldraw 内部二进制格式复杂，写错会破坏数据 |
| 调用现有 `/connect` | 无需改 server | 是 tldraw 私有 sync 协议，不对外暴露 CRUD |

---

## 2. 鉴权设计

### Bearer Token（简单静态 Token）

`MCP_TOKEN` 只存在于**服务端进程**（Fastify + MCP Server），永远不暴露到浏览器前端。

连接 `/mcp-bridge` 时，根据 `role` 参数区分两类客户端，采用不同的鉴权方式：

| 客户端 | 鉴权方式 | 说明 |
|--------|----------|------|
| **MCP Server**（外部进程） | `?token=<MCP_TOKEN>` | 必须携带正确 Token |
| **浏览器**（自己的前端） | 验证 `Origin` 头 | 只接受与 Fastify 同源的请求 |

```
# MCP Server 连接
ws://localhost:5858/mcp-bridge?role=mcp&token=<MCP_TOKEN>&roomId=yyy

# 浏览器连接（无需 token，由 Origin 校验）
ws://localhost:5858/mcp-bridge?role=browser&roomId=yyy
```

**为什么浏览器不用 Token**：`VITE_` 前缀的环境变量会被编译进 JS bundle，任何人都能从 DevTools 读到，毫无保护意义。浏览器客户端是可信的（已经在访问你的服务），用 Origin 校验即可防止外部浏览器冒充。

**验证逻辑**（Fastify 端）：

```typescript
// src/server/server.ts 新增
app.get('/mcp-bridge', { websocket: true }, async (socket, req) => {
  const { token, roomId, role } = req.query as Record<string, string>

  if (!roomId) {
    socket.close(4002, 'roomId required')
    return
  }

  if (role === 'mcp') {
    // MCP Server：验证 Bearer Token
    if (!token || token !== process.env.MCP_TOKEN) {
      socket.close(4001, 'Unauthorized')
      return
    }
  } else {
    // 浏览器：验证 Origin（必须与 Fastify 同源）
    const origin = req.headers.origin ?? ''
    const host = req.headers.host ?? ''
    if (!isAllowedOrigin(origin, host)) {
      socket.close(4003, 'Forbidden origin')
      return
    }
  }

  mcpBridgeManager.register(role, roomId, socket)
})
```

---

## 3. 数据流详解

### 查询流（get_shapes / get_context）

```
MCP Server
  │ 发送：{"type":"request","id":"req-1","action":"get_shapes","pageId":"page:xxx"}
  ▼
Fastify /mcp-bridge（转发给对应 roomId 的浏览器客户端）
  ▼
Browser useMcpBridge hook
  │ 执行：editor.getCurrentPageShapes() 或指定 pageId
  │ 回传：{"type":"response","id":"req-1","shapes":[...]}
  ▼
Fastify（转发回 MCP Server）
  ▼
MCP Server（返回给 AI agent）
```

### 变更流（create / update / delete）

```
MCP Server
  │ 发送：{"type":"request","id":"req-2","action":"create_shape","payload":{...}}
  ▼
Fastify /mcp-bridge
  ▼
Browser useMcpBridge hook
  │ 执行：editor.createShape({...})
  │ 注：tldraw sync 会自动将变更广播给所有连接该房间的客户端
  │ 回传：{"type":"response","id":"req-2","shapeId":"shape:abc"}
  ▼
MCP Server（返回成功给 AI agent）
```

### 上下文上报（browser 主动推送）

```
Browser（用户切换 page / 进入 room）
  │ 推送：{"type":"context","roomId":"my-room","pageId":"page:abc","pageName":"Page 1"}
  ▼
Fastify（缓存最新 context）
  ▼
MCP Server 调用 get_context 时直接返回缓存
```

---

## 4. WebSocket 消息协议

所有消息均为 JSON，通过 `/mcp-bridge` WebSocket 双向传递。

### MCP Server → Browser（请求）

```typescript
interface McpRequest {
  type: 'request'
  id: string           // 请求 ID，用于匹配响应
  action: McpAction
  payload?: unknown
}

type McpAction =
  | 'get_context'      // 获取当前 room + page 信息
  | 'get_shapes'       // 获取指定 page 的所有 shape
  | 'create_shape'     // 创建图形
  | 'update_shape'     // 更新图形属性
  | 'delete_shapes'    // 删除图形（支持批量）
  | 'get_pages'        // 获取 room 内所有 page 列表
```

### Browser → MCP Server（响应）

```typescript
interface McpResponse {
  type: 'response'
  id: string           // 与请求的 id 对应
  ok: boolean
  data?: unknown
  error?: string
}
```

### Browser → Fastify（主动上报 context）

```typescript
interface McpContextPush {
  type: 'context'
  roomId: string
  pageId: string
  pageName: string
  pageCount: number
}
```

---

## 5. MCP Tools 定义

### `list_rooms`

列出服务器上所有房间。

```typescript
{
  name: 'list_rooms',
  description: '列出 tldraw 服务器上所有画布房间',
  inputSchema: { type: 'object', properties: {} }
}
// 返回：{ rooms: [{ id, active, updatedAt }] }
```

### `get_context`

获取当前浏览器打开的 room 和激活的 page 信息。

```typescript
{
  name: 'get_context',
  description: '获取当前浏览器中激活的画布 room 和 page 信息',
  inputSchema: {
    type: 'object',
    properties: {
      roomId: { type: 'string', description: '房间 ID' }
    },
    required: ['roomId']
  }
}
// 返回：{ roomId, pageId, pageName, pageCount }
```

### `get_shapes`

获取指定房间、指定页面的所有图形数据。

```typescript
{
  name: 'get_shapes',
  description: '获取指定画布页面上的所有图形',
  inputSchema: {
    type: 'object',
    properties: {
      roomId: { type: 'string', description: '房间 ID' },
      pageId: { type: 'string', description: 'Page ID（不填则取当前激活 page）' }
    },
    required: ['roomId']
  }
}
// 返回：数组，每项含 id, type, x, y, rotation, w, h, text, color, geo（若有）；
// geo/text/note 另含 dash, size, font, align, verticalAlign, textAlign（视类型存在）
```

### `create_shape`

在指定房间的当前页面创建一个图形。

```typescript
{
  name: 'create_shape',
  description: '在 tldraw 画布上创建图形',
  inputSchema: {
    type: 'object',
    properties: {
      roomId: { type: 'string' },
      pageId: { type: 'string', description: '目标 page（不填则用当前激活 page）' },
      shapeType: {
        type: 'string',
        enum: ['geo', 'text', 'note', 'arrow'],
        description: 'geo = 矩形/椭圆等, text = 文字, note = 便签, arrow = 箭头'
      },
      x: { type: 'number', description: '画布坐标 X' },
      y: { type: 'number', description: '画布坐标 Y' },
      w: { type: 'number', description: '宽度（geo/note 类型）' },
      h: { type: 'number', description: '高度（geo/note 类型）' },
      text: { type: 'string', description: '文字内容' },
      color: {
        type: 'string',
        enum: ['black', 'blue', 'cyan', 'green', 'grey', 'light-blue',
               'light-green', 'light-red', 'light-violet', 'orange', 'red', 'violet', 'white', 'yellow']
      },
      geoType: {
        type: 'string',
        enum: ['rectangle', 'ellipse', 'triangle', 'diamond', 'hexagon', 'cloud', 'star'],
        description: '当 shapeType=geo 时指定具体形状'
      },
      fill: {
        type: 'string',
        enum: ['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill'],
        description: '填充样式（仅 geo）'
      },
      dash: {
        type: 'string',
        enum: ['solid', 'dashed', 'dotted', 'draw'],
        description: '轮廓线型（仅 geo）'
      },
      size: { type: 'string', enum: ['s', 'm', 'l', 'xl'], description: '线粗/字号档位（geo、text、note）' },
      font: { type: 'string', enum: ['draw', 'sans', 'serif', 'mono'], description: '字体（geo、text、note）' },
      align: { type: 'string', enum: ['start', 'middle', 'end'], description: '文字水平对齐（仅 geo、note）' },
      verticalAlign: { type: 'string', enum: ['start', 'middle', 'end'], description: '文字垂直对齐（仅 geo、note）' },
      textAlign: { type: 'string', enum: ['start', 'middle', 'end'], description: '水平对齐（仅 text）' }
    },
    required: ['roomId', 'shapeType', 'x', 'y']
  }
}
// 返回：{ shapeId: 'shape:abc123' }
```

### `update_shape`

更新已有图形的属性。

```typescript
{
  name: 'update_shape',
  description: '更新画布上已有图形的属性（位置/大小/文字/颜色等）',
  inputSchema: {
    type: 'object',
    properties: {
      roomId: { type: 'string' },
      shapeId: { type: 'string', description: '图形 ID（从 get_shapes 获取）' },
      x: { type: 'number' },
      y: { type: 'number' },
      w: { type: 'number' },
      h: { type: 'number' },
      text: { type: 'string' },
      color: { type: 'string' },
      dash: { type: 'string', enum: ['solid', 'dashed', 'dotted', 'draw'], description: '仅 geo' },
      size: { type: 'string', enum: ['s', 'm', 'l', 'xl'] },
      font: { type: 'string', enum: ['draw', 'sans', 'serif', 'mono'] },
      align: { type: 'string', enum: ['start', 'middle', 'end'], description: '仅 geo、note' },
      verticalAlign: { type: 'string', enum: ['start', 'middle', 'end'], description: '仅 geo、note' },
      textAlign: { type: 'string', enum: ['start', 'middle', 'end'], description: '仅 text' }
    },
    required: ['roomId', 'shapeId']
  }
}
// 返回：{ ok: true }
```

### `delete_shapes`

删除一个或多个图形。

```typescript
{
  name: 'delete_shapes',
  description: '删除画布上的图形（支持批量）',
  inputSchema: {
    type: 'object',
    properties: {
      roomId: { type: 'string' },
      shapeIds: {
        type: 'array',
        items: { type: 'string' },
        description: '要删除的图形 ID 列表'
      }
    },
    required: ['roomId', 'shapeIds']
  }
}
// 返回：{ ok: true, deleted: number }
```

---

## 6. 文件结构与改动清单

```
tldraw-selfhost/
├── src/
│   ├── server/
│   │   ├── server.ts            ← 【改】新增 /mcp-bridge WebSocket 端点 + 鉴权
│   │   ├── mcp-bridge.ts        ← 【新增】McpBridgeManager（管理 room→socket 映射）
│   │   └── rooms.ts             ← 无需改动
│   ├── client/
│   │   ├── App.tsx              ← 【改】在 RoomPage 中挂载 useMcpBridge hook
│   │   └── hooks/
│   │       └── useMcpBridge.ts  ← 【新增】浏览器端 MCP Bridge hook
│   └── mcp/
│       └── server.ts            ← 【新增】MCP Server 入口（独立进程，stdio）
├── .env.local                   ← 【改】新增 MCP_TOKEN
├── .env.example                 ← 【改】新增 MCP_TOKEN 示例
├── package.json                 ← 【改】新增 @modelcontextprotocol/sdk 依赖
│                                         新增 "mcp" script
└── docs/
    └── MCP_INTEGRATION.md       ← 本文档
```

### 新增/改动文件说明

#### `src/server/mcp-bridge.ts`（新增）

管理 MCP Server 与浏览器 client 之间的 WebSocket 会话：

- `McpBridgeManager` 类
  - `registerMcpClient(roomId, socket)` — MCP Server 接入
  - `registerBrowserClient(roomId, socket)` — Browser 接入  
  - `forward(roomId, msg)` — 将请求转发给 browser，等待响应
  - `broadcastContext(roomId, context)` — 缓存 browser 上报的 context

#### `src/client/hooks/useMcpBridge.ts`（新增）

React hook，在 `<RoomPage>` 中使用：

- 连接 `/mcp-bridge?token=xxx&roomId=yyy`
- 每次 `editor.currentPageId` 变化，推送 `context` 消息
- 监听 MCP 请求消息，调用对应的 `editor` API，回传结果

#### `src/mcp/server.ts`（新增）

独立 Node.js 进程，通过 `stdio` 与 AI agent 通信：

- 使用 `@modelcontextprotocol/sdk` 的 `McpServer` + `StdioServerTransport`
- 每个 tool handler 通过 WebSocket 连接 `/mcp-bridge`，发送请求并等待响应
- 支持 `list_rooms`（直接调 REST `/api/rooms`）、`get_context`、`get_shapes`、`create_shape`、`update_shape`、`delete_shapes`

---

## 7. 环境变量

在 `.env.local` 中新增：

```bash
# MCP Server 鉴权 Token（自定义一个随机字符串）
MCP_TOKEN=change-me-to-a-random-secret

# MCP Server 连接的 tldraw 服务地址（默认 localhost:5858）
TLDRAW_BASE_URL=http://localhost:5858
```

生成随机 Token 的方法：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 8. 接入各 AI 客户端的配置

### GitHub Copilot CLI

编辑 `~/.copilot/mcp-config.json`：

```json
{
  "mcpServers": {
    "tldraw": {
      "command": "node",
      "args": ["/absolute/path/to/tldraw-selfhost/dist/mcp/server.js"],
      "env": {
        "MCP_TOKEN": "your-token-here",
        "TLDRAW_BASE_URL": "http://localhost:5858"
      }
    }
  }
}
```

开发模式（用 tsx 直接运行，无需 build）：

```json
{
  "mcpServers": {
    "tldraw": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/tldraw-selfhost/src/mcp/server.ts"],
      "env": {
        "MCP_TOKEN": "your-token-here",
        "TLDRAW_BASE_URL": "http://localhost:5858"
      }
    }
  }
}
```

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "tldraw": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/tldraw-selfhost/src/mcp/server.ts"],
      "env": {
        "MCP_TOKEN": "your-token-here",
        "TLDRAW_BASE_URL": "http://localhost:5858"
      }
    }
  }
}
```

### Cursor

在项目根目录创建 `.cursor/mcp.json`（项目级）或编辑 `~/.cursor/mcp.json`（全局）：

```json
{
  "mcpServers": {
    "tldraw": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "env": {
        "MCP_TOKEN": "your-token-here",
        "TLDRAW_BASE_URL": "http://localhost:5858"
      }
    }
  }
}
```

---

## 9. 外网使用：可分发独立包（推荐）

> 适用场景：tldraw 服务部署在家里 / 服务器，外网另一台电脑的 Cursor 想直接使用 MCP，无需 clone 整个仓库。

### 9.1 发布机制

每次推送 `v*` 格式的 Git Tag，GitHub Actions（`.github/workflows/release-mcp.yml`）会自动：

1. 在 `packages/tldraw-selfhost-mcp/` 里构建（tsup bundle → 单文件 `dist/index.js`）
2. 执行 `npm pack` 得到 `tldraw-selfhost-mcp-X.Y.Z.tgz`（压缩后约 3 KB）
3. 上传到对应 Tag 的 GitHub Release Assets

```bash
# 发版操作（维护者）
git tag v1.0.0 && git push origin v1.0.0
# → CI 自动构建并发布 Release
```

### 9.2 前提：Cloudflare Access 配置（外网必须）

tldraw 服务通过 Cloudflare Tunnel 暴露时，需要让 MCP 进程以「机器身份」通过 Access 验证。

1. **创建 Service Token**  
   Zero Trust 控制台 → **Access → Service Auth → Service Tokens** → 新建 → 保存 **Client ID** 和 **Client Secret**（只显示一次）

2. **在保护站点的 Access Application 里增加一条 Allow 策略**  
   条件选 **Service Auth → Service Token** → 选刚创建的 Token；保留原有 Email OTP 策略，两者 OR 关系并存（人用邮箱、机器用 Service Token）

3. **把 ID/Secret 填入下面的 env**

### 9.3 使用方 Cursor 配置

编辑 `~/.cursor/mcp.json`（全局）或 `.cursor/mcp.json`（项目级）：

```json
{
  "mcpServers": {
    "tldraw": {
      "command": "npx",
      "args": [
        "-y",
        "https://github.com/OWNER/REPO/releases/download/v1.0.0/tldraw-selfhost-mcp-1.0.0.tgz"
      ],
      "env": {
        "TLDRAW_BASE_URL": "https://你的CF-Tunnel域名",
        "MCP_TOKEN": "与服务端相同的 MCP_TOKEN",
        "CF_ACCESS_CLIENT_ID": "CF Service Token Client ID",
        "CF_ACCESS_CLIENT_SECRET": "CF Service Token Client Secret"
      }
    }
  }
}
```

> **升级 MCP 时**：把 `args` 里 URL 中的版本号（`v1.0.0` / `1.0.0`）替换为新 Tag 版本，保存即可。其余 env 无需改动。

### 9.4 本地开发时（同机器直连）

本地跑 tldraw 时可以继续用原来的方式，不必经过分发包：

```json
{
  "mcpServers": {
    "tldraw": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "env": {
        "MCP_TOKEN": "your-token-here",
        "TLDRAW_BASE_URL": "http://localhost:5858"
      }
    }
  }
}
```

---

## 10. 实现步骤

### Step 1：安装依赖

```bash
npm install @modelcontextprotocol/sdk
```

### Step 2：生成 MCP Token

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 将输出写入 .env.local 的 MCP_TOKEN
```

### Step 3：实现 `src/server/mcp-bridge.ts`

核心数据结构：

```typescript
interface BridgeRoom {
  mcpSocket: WebSocket | null       // MCP Server 连接
  browserSocket: WebSocket | null   // 浏览器客户端连接
  context: McpContextPush | null    // 浏览器上报的最新 context
  pendingRequests: Map<string, {
    resolve: (data: unknown) => void
    reject: (err: Error) => void
    timeout: NodeJS.Timeout
  }>
}
```

关键方法 `forward(roomId, request, timeoutMs = 10000)`：
1. 找到该 room 的 browserSocket
2. 发送 request JSON
3. 返回 Promise，等待 response（按 id 匹配），超时 reject

### Step 4：改造 `src/server/server.ts`

新增 `/mcp-bridge` WebSocket 端点：

```typescript
// 在现有 websocket 路由区域下方新增
app.get('/mcp-bridge', { websocket: true }, async (socket, req) => {
  const { token, roomId, role } = req.query as Record<string, string>

  if (token !== process.env.MCP_TOKEN) {
    socket.close(4001, 'Unauthorized')
    return
  }

  if (role === 'browser') {
    mcpBridge.registerBrowserClient(roomId, socket)
  } else {
    mcpBridge.registerMcpClient(roomId, socket)
  }
})
```

### Step 5：实现 `src/client/hooks/useMcpBridge.ts`

```typescript
export function useMcpBridge(editor: Editor, roomId: string) {
  useEffect(() => {
    // 浏览器连接不需要 token，由服务端 Origin 校验
    const ws = new WebSocket(
      `${getWsBridgeUri()}?role=browser&roomId=${roomId}`
    )

    ws.onmessage = async (event) => {
      const req = JSON.parse(event.data) as McpRequest

      try {
        const data = await handleMcpRequest(editor, req)
        ws.send(JSON.stringify({ type: 'response', id: req.id, ok: true, data }))
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'response', id: req.id, ok: false, error: err.message }))
      }
    }

    // 上报当前 context
    const reportContext = () => {
      ws.send(JSON.stringify({
        type: 'context',
        roomId,
        pageId: editor.getCurrentPageId(),
        pageName: editor.getCurrentPage().name,
        pageCount: editor.getPages().length,
      }))
    }

    // 监听 page 切换
    const cleanup = editor.store.listen(reportContext, { scope: 'session' })
    ws.onopen = reportContext

    return () => {
      cleanup()
      ws.close()
    }
  }, [editor, roomId])
}
```

### Step 6：实现 `src/mcp/server.ts`

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'tldraw-selfhost', version: '1.0.0' })
const BASE_URL = process.env.TLDRAW_BASE_URL ?? 'http://localhost:5858'
const TOKEN = process.env.MCP_TOKEN ?? ''

// list_rooms：直接调 REST，不需要 WS
server.tool('list_rooms', '列出所有 tldraw 画布房间', {}, async () => {
  const res = await fetch(`${BASE_URL}/api/rooms`)
  const { rooms } = await res.json()
  return { content: [{ type: 'text', text: JSON.stringify(rooms, null, 2) }] }
})

// get_shapes、create_shape 等通过 WS Bridge 转发给浏览器
// ...（详见实现）

await server.connect(new StdioServerTransport())
```

### Step 7：在 `App.tsx` 中挂载 hook

```typescript
// RoomPage 内
const onMount = useCallback((editor: Editor) => {
  editorRef.current = editor
  editor.registerExternalAssetHandler('url', unfurlBookmarkUrl)
  // 新增：启动 MCP bridge 连接
  initMcpBridge(editor, roomId)   // 或用 hook
}, [roomId])
```

### Step 8：package.json 新增脚本

```json
{
  "scripts": {
    "mcp": "tsx src/mcp/server.ts"
  }
}
```

---

## 使用示例

### 在 Copilot CLI 中

```
> 帮我在 tldraw 的 my-room 里画一个用户注册的流程图
```

Copilot 会自动调用：
1. `list_rooms` → 确认 my-room 存在
2. `get_context` → 获取当前 page
3. 多次 `create_shape` → 创建矩形节点、箭头连线、文字标注

### 在 Claude Desktop 中

```
用 tldraw 的 MCP 工具，帮我看看 my-room 里现在有什么内容，
然后在右侧空白处加上一个 "Deploy" 流程节点，颜色用绿色
```

Claude 会：
1. `get_shapes` → 读取现有内容，分析布局
2. `create_shape(type=geo, geoType=rectangle, color=green, text="Deploy", x=..., y=...)` → 在合适位置创建

---

## 注意事项

1. **浏览器必须已打开对应 Room**：MCP 通过浏览器客户端操作 editor，若该 Room 没有浏览器打开，变更类操作会返回错误（查询类可降级为 REST 读 SQLite）。
2. **多浏览器客户端**：同一 Room 有多个浏览器 tab 时，MCP 命令只发给最后连接的那个（可扩展为广播）。
3. **Token 安全**：`MCP_TOKEN` 只在服务端进程中使用，不会出现在任何前端代码或 bundle 中。浏览器连接通过 Origin 校验，无需 token。
4. **tldraw 坐标系**：画布坐标以像素为单位，(0,0) 在画布原点（非视口中心），AI 需要参考 `get_shapes` 返回的已有 shape 位置来推断合适的放置坐标。
