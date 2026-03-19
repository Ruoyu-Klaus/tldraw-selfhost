# tldraw 多人画图 + 多平台同步 + 本地持久化 — 方案调研

## 需求摘要

- **多人画图**：实时协作，多用户同时编辑同一画布  
- **多平台同步**：Web / 多设备通过同一后端同步状态  
- **数据持久化本地**：画布数据存储在本地，不依赖第三方云存储  
- **可自部署**：能在本地机器（或内网服务器）上部署运行  

---

## 官方能力概览

tldraw 提供 **tldraw sync** 实现实时多人同步，包含：

- **前端**：`@tldraw/sync` 的 `useSync`，通过 WebSocket 连接后端  
- **后端**：`@tldraw/sync-core` 的 `TLSocketRoom`，每个「房间」一个权威状态，支持持久化  
- **存储**：`InMemorySyncStorage`（仅内存）或 **`SQLiteSyncStorage`**（推荐，持久化）  
- **资源**：大文件（图片/视频）需自建或对接 Asset 存储  

官方文档：[tldraw sync](https://tldraw.dev/docs/sync)  

---

## 方案对比

| 维度           | 方案 A：Simple Server（Node/Bun） | 方案 B：Cloudflare 模板 / Multiplayer 模板 |
|----------------|-----------------------------------|--------------------------------------------|
| **部署位置**   | 本地机器 / 内网服务器             | Cloudflare Workers + Durable Objects       |
| **数据存放**   | 本地磁盘 SQLite（如 `.rooms/`）   | Cloudflare Durable Object SQLite + R2      |
| **是否「纯本地」** | ✅ 是                             | ❌ 否，依赖 Cloudflare 基础设施             |
| **多人实时**   | ✅ WebSocket 多端同步              | ✅ 同左                                     |
| **多平台**     | ✅ 任意能连你服务器的客户端        | ✅ 同左                                     |
| **资源存储**   | 需自建（本地目录 / 对象存储等）    | 模板内建 R2                                 |
| **模板来源**   | tldraw 主仓 `templates/simple-server-example` | `npm create tldraw@latest -- --template multiplayer` 或 `tldraw-sync-cloudflare` |
| **适用场景**   | 自托管、内网、数据不出本机         | 公网、希望用 Cloudflare 托管后端与资源      |

结论：**若必须「数据持久化本地 + 自部署到本地机器」**，应选 **方案 A（Simple Server）**；若可接受数据在 Cloudflare，可选方案 B。

---

## 推荐方案：基于 Simple Server 的本地服务

### 技术栈

- **后端**：Node.js 或 Bun  
- **Web/WebSocket**：如 Fastify（Node）或 Bun.serve + itty-router（Bun）  
- **同步与持久化**：`@tldraw/sync-core`  
  - `TLSocketRoom`：每房间一个 Room，处理 WebSocket 与状态同步  
  - `SQLiteSyncStorage` + `NodeSqliteWrapper`：持久化到本地 SQLite  
- **前端**：Vite + React + `tldraw` + `@tldraw/sync` 的 `useSync`，连接本机/内网 WebSocket  
- **资源（图片/视频）**：在 Simple Server 上自建上传接口，存本地目录或兼容 S3 的存储  

### 数据流简述

1. 前端通过 `useSync({ uri: 'ws://your-server/connect/:roomId', assets })` 连接后端。  
2. 后端按 `roomId` 创建/复用 `TLSocketRoom`，底层用 `SQLiteSyncStorage` 读写 SQLite（如按 room 分库或分表）。  
3. 任意端修改 → 发到 Room → 广播给同房间所有客户端，实现多人画图与多平台同步。  
4. 所有文档状态落在本地 SQLite 文件中，实现数据持久化本地。  

### 与官方 Simple Server Example 的对应关系

- 官方示例：[tldraw/tldraw — templates/simple-server-example](https://github.com/tldraw/tldraw/tree/main/templates/simple-server-example)  
- 特点：  
  - 支持 Node 与 Bun；  
  - 房间数据持久化到 **`.rooms` 目录下的 SQLite**；  
  - 含简单前端与 unfurl（书签）示例；  
  - 资源存储需按需扩展（示例中可能仅为占位或简单本地存储）。  

可直接以该模板为起点，在现有基础上：  
- 确认/完善资源上传与本地存储路径；  
- 如需认证、房间列表、限流等，在现有 Server 上增加路由与中间件。  

### 本地部署要点

- 在本机或内网一台机器上运行 Simple Server（`yarn dev` / `node server.js` 等）。  
- 前端构建后可通过同一域名/端口提供静态资源，或单独用 Nginx 反代。  
- WebSocket 的 `uri` 指向该机器（如 `ws://localhost:3000/connect/:roomId` 或 `ws://192.168.x.x:3000/connect/:roomId`）。  
- SQLite 文件路径配置为本地磁盘目录（如 `./.rooms`），即实现「数据持久化本地」。  

---

## 方案 B 简述（Cloudflare，非本地数据）

- 使用：`npm create tldraw@latest -- --template multiplayer` 或克隆 [tldraw-sync-cloudflare](https://github.com/tldraw/tldraw-sync-cloudflare)。  
- 后端与状态在 Cloudflare Durable Objects，文档快照与资源在 R2；数据不在你本机。  
- 适合：希望零运维后端、能接受数据在 Cloudflare 的场景。  

---

## 建议实施顺序

1. **克隆/拉取 simple-server-example**（从 tldraw 主仓或复制模板到当前仓库）。  
2. **在本地跑通**：`yarn dev`，浏览器访问前端，创建房间，确认多人同房间可实时画图、刷新后数据仍在（SQLite 持久化）。  
3. **确认资源存储**：若模板未实现完整资源持久化，为图片/视频增加「上传到本地目录」或本地兼容 S3 的存储。  
4. **按需扩展**：认证、房间列表、HTTPS/WSS（如用 Nginx 或 Caddy 反代）、限流与大小限制等。  

如需，我可以基于 `simple-server-example` 在你当前仓库里搭一版可直接运行的「多人画图 + 多平台同步 + 数据持久化本地」的脚手架（含目录结构和关键代码说明）。
