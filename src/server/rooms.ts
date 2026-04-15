import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import Database from 'better-sqlite3'
import { mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// Canvas data: one SQLite file per room under .rooms/
const DIR = './.rooms'
mkdirSync(DIR, { recursive: true })

function sanitizeRoomId(roomId: string): string {
  return roomId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

const rooms = new Map<string, TLSocketRoom>()

export function makeOrLoadRoom(roomId: string): TLSocketRoom {
  roomId = sanitizeRoomId(roomId)

  const existing = rooms.get(roomId)
  if (existing && !existing.isClosed()) {
    return existing
  }

  console.log('[room] loading room:', roomId)

  const db = new Database(join(DIR, `${roomId}.db`))
  const sql = new NodeSqliteWrapper(db)
  const storage = new SQLiteSyncStorage({ sql })

  const room = new TLSocketRoom({
    storage,
    onSessionRemoved(room, args) {
      console.log('[room] client disconnected:', args.sessionId, 'room:', roomId)
      if (args.numSessionsRemaining === 0) {
        console.log('[room] closing empty room:', roomId)
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
  active: boolean
  updatedAt: number
}

export function listRooms(): RoomInfo[] {
  const activeIds = new Set(rooms.keys())
  const result: RoomInfo[] = []

  try {
    const files = readdirSync(DIR)
    for (const file of files) {
      if (!file.endsWith('.db')) continue
      const id = file.slice(0, -3)
      const filepath = join(DIR, file)
      const updatedAt = statSync(filepath).mtimeMs
      result.push({ id, active: activeIds.has(id), updatedAt })
    }
  } catch {
    // Missing .rooms/ → empty list
  }

  result.sort((a, b) => b.updatedAt - a.updatedAt)
  return result
}
