// 依据（basis）计算：纸批号 + 版位摘要是分片能否复用的唯一凭据。
// 版位摘要只取几何信息，同一几何在同一纸批次下才视为依据一致。

export type DigestPosition = {
  id: string
  pageNo: number
  spreadId: string
  front: boolean
  x: number
  y: number
  rotation: number
}

// FNV-1a 32bit，输出 8 位十六进制摘要
export function digest(parts: Array<string | number | undefined | null>): string {
  const text = parts.map((part) => String(part ?? '')).join('|')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (`0000000${(hash >>> 0).toString(16)}`).slice(-8)
}

export function digestPositions(positions: DigestPosition[]): string {
  const ordered = [...positions].sort((a, b) => a.id.localeCompare(b.id))
  return digest(ordered.flatMap((p) => [p.id, p.pageNo, p.spreadId, p.front ? 1 : 0, p.x, p.y, p.rotation]))
}

// 分片级摘要：只覆盖该分片包含的页位，换纸后未受影响的分片可能保持一致
export function digestForPages(positions: DigestPosition[], pageNos: number[]): string {
  return digestPositions(positions.filter((p) => pageNos.includes(p.pageNo)))
}

export function shortDigest(value?: string) {
  return value ? value.slice(0, 4) : '----'
}
