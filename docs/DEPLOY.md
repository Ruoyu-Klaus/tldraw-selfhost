# 生产部署指南（Mac Mini + CF Tunnel / Tailscale）

## 一、在 Mac Mini 上部署服务

### 1. 克隆代码 & 安装依赖

```bash
git clone <your-repo> tldraw-selfhost
cd tldraw-selfhost
npm install
```

### 2. 构建前端

```bash
npm run build
# 输出到 dist/client/，后端生产模式下会自动托管这些静态文件
```

### 3. 安装 PM2

```bash
npm install -g pm2
```

### 4. 启动服务

```bash
pm2 start ecosystem.config.cjs
```

常用命令：

```bash
pm2 list                  # 查看所有进程状态
pm2 logs tldraw           # 实时查看日志
pm2 restart tldraw        # 重启
pm2 stop tldraw           # 停止
pm2 delete tldraw         # 移除
```

### 5. 设置开机自启

```bash
# 生成 macOS launchd 启动脚本并安装
pm2 startup
# 按照输出的提示执行那条 sudo 命令，然后：
pm2 save
```

之后每次 Mac Mini 重启，tldraw 服务会自动拉起。

### 6. 更新部署流程

```bash
git pull
npm install          # 依赖有变化时
npm run build        # 重新构建前端
pm2 restart tldraw   # 重启服务（数据不丢失）
```

---

## 二、外网访问方案

### 方案 A：Cloudflare Tunnel（推荐，有公网域名）

适合：想通过域名（如 `draw.yourdomain.com`）从任何地方访问。

**前提**：有一个托管在 Cloudflare 的域名。

```bash
# 1. 在 Mac Mini 上安装 cloudflared
brew install cloudflare/cloudflare/cloudflared

# 2. 登录 Cloudflare
cloudflared tunnel login

# 3. 创建 tunnel
cloudflared tunnel create tldraw

# 4. 配置路由（把域名指向本地端口）
cloudflared tunnel route dns tldraw draw.yourdomain.com
```

创建配置文件 `~/.cloudflared/config.yml`：

```yaml
tunnel: <上面创建后输出的 tunnel-id>
credentials-file: /Users/<你的用户名>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: draw.yourdomain.com
    service: http://localhost:5858
  - service: http_status:404
```

```bash
# 5. 启动 tunnel（临时测试）
cloudflared tunnel run tldraw

# 6. 用 PM2 管理 tunnel，让它也开机自启
pm2 start "cloudflared tunnel run tldraw" --name cf-tunnel
pm2 save
```

访问：`https://draw.yourdomain.com`（Cloudflare 自动提供 HTTPS）

---

### 方案 B：Tailscale（推荐，纯内网/零信任）

适合：只需要自己和家人访问，不需要公网域名。

```bash
# 1. Mac Mini 上安装 Tailscale
brew install tailscale
sudo tailscaled &
sudo tailscale up

# 2. 在手机 / 其他电脑上也安装 Tailscale 并登录同一账号
```

登录后，在 Tailscale 管理面板 (https://login.tailscale.com/admin/machines) 找到 Mac Mini 的 Tailscale IP（格式如 `100.x.x.x`）。

访问：`http://100.x.x.x:5858`

**Tailscale Funnel（可选，生成公网 HTTPS URL）：**

```bash
# 在 Mac Mini 上开启 Funnel，暴露到公网
sudo tailscale funnel 5858
# 会给你一个 https://macmini.<tailnet>.ts.net 形式的 URL
```

---

## 三、数据备份

数据都在项目目录下：

| 目录 | 内容 | 备份优先级 |
|------|------|-----------|
| `.rooms/` | 所有画布 SQLite 数据库 | ⭐⭐⭐ 最重要 |
| `.assets/` | 上传的图片/视频 + unfurl 缓存 | ⭐⭐ 重要 |

推荐用 Time Machine 或 rsync 定期备份：

```bash
# 示例：每天备份到外接硬盘
rsync -av /path/to/tldraw-selfhost/.rooms/ /Volumes/Backup/tldraw-rooms/
rsync -av /path/to/tldraw-selfhost/.assets/ /Volumes/Backup/tldraw-assets/
```

---

## 四、环境变量

在 `ecosystem.config.cjs` 的 `env` 中配置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务监听端口 | `5858` |
| `NODE_ENV` | 运行模式（production 时托管前端静态文件） | `development` |
