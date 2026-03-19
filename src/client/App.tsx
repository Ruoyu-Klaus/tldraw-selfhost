import { useSync } from '@tldraw/sync'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AssetRecordType,
  Editor,
  getHashForString,
  TLAssetStore,
  TLBookmarkAsset,
  Tldraw,
  uniqueId,
} from 'tldraw'
import './index.css'

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function getWsUri(roomId: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/connect/${roomId}`
}

// ── 资源（图片/视频）上传到本地磁盘 ──────────────────────────────────────────

const assetStore: TLAssetStore = {
  async upload(_asset, file) {
    const id = uniqueId()
    const objectName = `${id}-${file.name}`.replace(/[^a-zA-Z0-9.\-_]/g, '-')
    const url = `/uploads/${encodeURIComponent(objectName)}`

    const res = await fetch(url, { method: 'PUT', body: file })
    if (!res.ok) throw new Error(`上传失败: ${res.statusText}`)

    return { src: url }
  },
  resolve(asset) {
    return asset.props.src
  },
}

// ── 书签 unfurl（链接预览元数据） ────────────────────────────────────────────

async function unfurlBookmarkUrl({ url }: { url: string }): Promise<TLBookmarkAsset> {
  const asset: TLBookmarkAsset = {
    id: AssetRecordType.createId(getHashForString(url)),
    typeName: 'asset',
    type: 'bookmark',
    meta: {},
    props: { src: url, description: '', image: '', favicon: '', title: '' },
  }

  try {
    const res = await fetch(`/unfurl?url=${encodeURIComponent(url)}`)
    const data = await res.json()
    asset.props.description = data?.description ?? ''
    asset.props.image = data?.image ?? ''
    asset.props.favicon = data?.favicon ?? ''
    asset.props.title = data?.title ?? ''
  } catch (e) {
    console.warn('[unfurl] 失败:', e)
  }

  return asset
}

function RoomPage({
  roomId,
  onBack,
}: {
  roomId: string
  onBack: () => void
}) {
  const store = useSync({
    uri: getWsUri(roomId),
    assets: assetStore,
  })

  const editorRef = useRef<Editor | null>(null)

  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    editor.registerExternalAssetHandler('url', unfurlBookmarkUrl)
  }, [])

  const handleExport = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const snapshot = editor.getSnapshot()
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${roomId}-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [roomId])

  const handleImport = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const snapshot = JSON.parse(text)
        editorRef.current?.loadSnapshot(snapshot)
      } catch (e) {
        alert('导入失败：JSON 格式无效')
        console.error(e)
      }
    }
    input.click()
  }, [])

  return (
    <>
      <div className="room-header">
        <button className="back-btn" onClick={onBack}>
          &larr; 返回
        </button>
        <span>
          房间：<strong>{roomId}</strong>
        </span>
        <div className="room-header-actions">
          <button className="snapshot-btn" onClick={handleImport} title="导入快照（覆盖当前画布）">
            &uarr; 导入
          </button>
          <button className="snapshot-btn" onClick={handleExport} title="导出当前画布为 JSON">
            &darr; 导出
          </button>
        </div>
      </div>
      <div className="room-canvas">
        <Tldraw
          store={store}
          onMount={onMount}
          licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
        />
      </div>
    </>
  )
}

// ── 大厅页（创建 / 加入房间） ────────────────────────────────────────────────

interface RoomInfo {
  id: string
  active: boolean
  updatedAt: number
}

function LobbyPage({ onEnter }: { onEnter: (roomId: string) => void }) {
  const [input, setInput] = useState('')
  const [rooms, setRooms] = useState<RoomInfo[]>([])

  useEffect(() => {
    const fetchRooms = async () => {
      try {
        const res = await fetch('/api/rooms')
        const data = await res.json()
        setRooms(data.rooms ?? [])
      } catch {
        // 服务未就绪时静默失败
      }
    }
    fetchRooms()
    const timer = setInterval(fetchRooms, 5000)
    return () => clearInterval(timer)
  }, [])

  const handleEnter = () => {
    const id = input.trim() || `room-${Date.now()}`
    onEnter(id)
  }

  return (
    <div className="lobby">
      <h1>🎨 tldraw 多人画板</h1>
      <p>输入房间 ID 进入（留空自动生成），同一房间 ID 即可多人协作</p>

      <div className="lobby-form">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleEnter()}
          placeholder="房间 ID（留空自动生成）"
          autoFocus
        />
        <button onClick={handleEnter}>进入 / 新建</button>
      </div>

      {rooms.length > 0 && (
        <>
          <p className="lobby-list-title">历史房间（按最近修改排序）</p>
          <div className="lobby-list">
            {rooms.map(({ id, active, updatedAt }) => (
              <div key={id} className="lobby-list-item">
                <div className="lobby-list-item-info">
                  <span className="lobby-room-id">{id}</span>
                  <span className="lobby-room-meta">
                    {active && <span className="lobby-badge-active">● 活跃</span>}
                    <span className="lobby-room-time">{formatTime(updatedAt)}</span>
                  </span>
                </div>
                <button onClick={() => onEnter(id)}>进入</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function formatTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return new Date(ms).toLocaleDateString('zh-CN')
}

// ── 根组件 ───────────────────────────────────────────────────────────────────

export default function App() {
  // 从 URL hash 中读取房间 ID，支持直接分享链接
  const [roomId, setRoomId] = useState<string | null>(() => {
    const hash = location.hash.replace(/^#/, '').trim()
    return hash || null
  })

  const handleEnter = (id: string) => {
    location.hash = id
    setRoomId(id)
  }

  const handleBack = () => {
    location.hash = ''
    setRoomId(null)
  }

  if (roomId) {
    return <RoomPage roomId={roomId} onBack={handleBack} />
  }

  return <LobbyPage onEnter={handleEnter} />
}
