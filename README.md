# tldraw 自部署多人画板

基于 [tldraw](https://tldraw.dev) 官方 simple-server-example 模板，实现：

- **多人实时协作**：同一房间多端同时编辑，WebSocket 实时同步
- **多平台支持**：任何能访问服务器的设备（PC / 手机 / 平板）均可使用
- **数据持久化本地**：画布数据存本地 SQLite (`.rooms/<roomId>.db`)，图片/视频存本地磁盘 (`.assets/`)，重启后数据不丢失
- **房间隔离**：不同 roomId 的画布完全独立；可同时运行多个房间

## 技术栈

| 部分 | 技术 |
|------|------|
| 后端框架 | [Fastify](https://fastify.dev) + `@fastify/websocket` |
| 同步引擎 | `@tldraw/sync-core` `TLSocketRoom` |
| 持久化 | `better-sqlite3` + `SQLiteSyncStorage` |
| 前端 | React 19 + Vite + `tldraw` + `useSync` |
| 资源存储 | 本地磁盘（`.assets/` 目录） |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动开发模式（同时启动后端 :5858 和前端 :5757）
npm run dev
```

浏览器访问 **http://localhost:5757**，输入任意 Room ID 进入画板，在另一个浏览器（或设备）访问同一 URL 并输入相同 Room ID 即可多人协作。

## 目录结构

```
tldraw-selfhost/
├── src/
│   ├── server/
│   │   ├── server.ts        # Fastify 主服务（WebSocket + REST）
│   │   ├── rooms.ts         # TLSocketRoom 管理 + SQLite 持久化
│   │   ├── assets.ts        # 本地文件上传/下载
│   │   └── unfurl.ts        # 书签链接预览
│   └── client/
│       ├── App.tsx           # 大厅 + 画板页（useSync 接入）
│       ├── main.tsx
│       └── index.css
├── public/
├── .rooms/                  # 画布 SQLite 数据（运行后自动创建）
├── .assets/                 # 上传的图片/视频（运行后自动创建）
├── vite.config.mts
└── package.json
```

## 生产部署（本机/内网服务器）

```bash
# 1. 构建前端
npm run build

# 2. 以生产模式启动（后端同时托管前端静态文件）
NODE_ENV=production node --import tsx/esm src/server/server.ts
# 或者先编译再运行：
npx tsc -p tsconfig.node.json && node dist/server/server.js
```

访问 **http://your-server-ip:5858**（前后端同端口）。

如需对外公开，建议在前面加 Nginx/Caddy 做反代 + HTTPS（WSS）。

## 端口配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 后端监听端口 | `5858` |

```bash
PORT=8080 npm run dev:server
```

## 数据目录

| 目录 | 内容 | 说明 |
|------|------|------|
| `.rooms/` | `<roomId>.db` | 每个房间一个 SQLite 文件 |
| `.assets/` | 图片/视频等 | PUT /uploads 上传的文件 |

这两个目录均已加入 `.gitignore`，请自行备份。

## API 接口

| 路由 | 说明 |
|------|------|
| `WS /connect/:roomId` | 多人同步 WebSocket |
| `PUT /uploads/:id` | 上传资源文件 |
| `GET /uploads/:id` | 下载资源文件 |
| `GET /unfurl?url=` | 书签链接预览 |
| `GET /api/rooms` | 活跃房间列表 |
| `GET /api/health` | 健康检查 |
