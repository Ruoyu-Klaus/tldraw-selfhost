import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import Database from 'better-sqlite3'
import { mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// 画布数据持久化到本地 .rooms/ 目录，每个房间一个 SQLite 文件
const DIR = './.rooms'
mkdirSync(DIR, { recursive: true })

// 过滤 roomId 中的危险字符，防止路径穿越攻击
function sanitizeRoomId(roomId: string): string {
  return roomId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// 活跃房间的内存映射表
const rooms = new Map<string, TLSocketRoom>()

export function makeOrLoadRoom(roomId: string): TLSocketRoom {
  roomId = sanitizeRoomId(roomId)

  const existing = rooms.get(roomId)
  if (existing && !existing.isClosed()) {
    return existing
  }

  console.log('[room] 加载房间:', roomId)

  // 每个房间对应一个 SQLite 文件，进程重启后数据仍然保留
  const db = new Database(join(DIR, `${roomId}.db`))
  const sql = new NodeSqliteWrapper(db)
  const storage = new SQLiteSyncStorage({ sql })

  const room = new TLSocketRoom({
    storage,
    onSessionRemoved(room, args) {
      console.log('[room] 客户端断开:', args.sessionId, '房间:', roomId)
      if (args.numSessionsRemaining === 0) {
        console.log('[room] 关闭空房间:', roomId)
        room.close()
        db.close()
        rooms.delete(roomId)
      }
    },
  })

  rooms.set(roomId, room)
  return room
}

export interface RoomInfo {
  id: string
  active: boolean      // 当前是否有人连接
  updatedAt: number    // 文件最后修改时间（ms）
}

// 读取磁盘上所有 .db 文件 + 内存活跃状态，合并成房间列表
export function listRooms(): RoomInfo[] {
  const activeIds = new Set(rooms.keys())
  const result: RoomInfo[] = []

  try {
    const files = readdirSync(DIR)
    for (const file of files) {
      if (!file.endsWith('.db')) continue
      const id = file.slice(0, -3)           // 去掉 .db 后缀
      const filepath = join(DIR, file)
      const updatedAt = statSync(filepath).mtimeMs
      result.push({ id, active: activeIds.has(id), updatedAt })
    }
  } catch {
    // .rooms/ 目录不存在时静默返回空
  }

  // 按最近修改时间倒序排列
  result.sort((a, b) => b.updatedAt - a.updatedAt)
  return result
}
