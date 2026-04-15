import { mkdir, readFile, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { Readable } from 'stream'

// Media files persisted under .assets/
const DIR = resolve('./.assets')

export async function storeAsset(id: string, stream: Readable): Promise<void> {
  await mkdir(DIR, { recursive: true })
  await writeFile(join(DIR, id), stream)
}

export async function loadAsset(id: string): Promise<Buffer> {
  return readFile(join(DIR, id))
}
