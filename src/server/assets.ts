import { mkdir, readFile, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { Readable } from 'stream'

// 图片、视频等资源持久化到本地 .assets/ 目录
const DIR = resolve('./.assets')

export async function storeAsset(id: string, stream: Readable): Promise<void> {
  await mkdir(DIR, { recursive: true })
  await writeFile(join(DIR, id), stream)
}

export async function loadAsset(id: string): Promise<Buffer> {
  return readFile(join(DIR, id))
}
