<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { Position, Validation } from '../stores/imposition'

const props = withDefaults(defineProps<{
  positions: Position[]
  side: 'front' | 'back'
  zoom: number
  selected: string | null
  validations: Validation[]
  paperWidth?: number
  paperHeight?: number
  paperCode?: string
  clampX?: (x: number) => number
  clampY?: (y: number) => number
  interactive?: boolean
}>(), {
  paperWidth: 720,
  paperHeight: 1020,
  paperCode: 'CH-0910-A',
  interactive: true,
})

const emit = defineEmits<{
  update: [id: string, patch: Partial<Position>]
  select: [id: string]
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const dragging = ref<string | null>(null)
const dragOffset = ref({ x: 0, y: 0 })

const W = 800
const H = 1120
const PAGE_W = 300
const PAGE_H = 410

const statusColor: Record<Position['status'], string> = {
  confirmed: '#3b8a67',
  pending: '#bf7f2c',
  invalidated: '#bd4a34',
}

function draw() {
  const element = canvas.value
  if (!element) return
  const ctx = element.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = '#d7dddf'
  ctx.fillRect(0, 0, W, H)

  // 纸张按批次宽高比例展示（名义 mm 映射到画布，留 40px 边距）
  const paperW = Math.min(W - 80, props.paperWidth)
  const paperH = Math.min(H - 120, props.paperHeight)
  const px = (W - paperW) / 2
  const py = 40
  ctx.shadowColor = 'rgba(23,45,54,.22)'
  ctx.shadowBlur = 18
  ctx.fillStyle = '#fffefb'
  ctx.fillRect(px, py, paperW, paperH)
  ctx.shadowBlur = 0
  ctx.strokeStyle = '#b8c3c6'
  ctx.setLineDash([5, 5])
  ctx.strokeRect(px + 18, py + 18, paperW - 36, paperH - 36)
  ctx.setLineDash([])
  // 色彩控制条
  ctx.fillStyle = '#e69a4b'
  ctx.fillRect(px + 28, py + paperH - 24, paperW - 56, 10)
  for (let index = 0; index < 7; index += 1) {
    ctx.fillStyle = ['#28a4d8', '#ef3b9b', '#f4d62c', '#1a1a1a', '#30c3aa', '#ef4c36', '#5c67cd'][index]
    ctx.fillRect(px + 28 + index * ((paperW - 56) / 7), py + paperH - 24, (paperW - 56) / 7, 10)
  }
  ctx.fillStyle = '#26373d'
  ctx.font = 'bold 15px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(`${props.side === 'front' ? '正面' : '反面'}拼版版式`, 48, 28)
  ctx.font = '11px sans-serif'
  ctx.fillStyle = '#76848a'
  ctx.fillText(`纸张 ${props.paperWidth} × ${props.paperHeight} mm · 批次 ${props.paperCode} · 出血 3mm · 骑马订`, 180, 28)

  props.positions.filter((item) => item.front === (props.side === 'front')).forEach((position) => {
    const x = position.x + 10
    const y = position.y + 24
    const hasIssue = props.validations.some((issue) => issue.pageNo === position.pageNo)
    ctx.save()
    ctx.translate(x + PAGE_W / 2, y + PAGE_H / 2)
    ctx.rotate((position.rotation * Math.PI) / 180)
    ctx.translate(-PAGE_W / 2, -PAGE_H / 2)
    if (position.id === props.selected) {
      ctx.shadowColor = 'rgba(31,113,123,.35)'
      ctx.shadowBlur = 14
    }
    ctx.globalAlpha = position.status === 'invalidated' ? 0.62 : 1
    ctx.fillStyle = '#f7f7f2'
    ctx.fillRect(0, 0, PAGE_W, PAGE_H)
    ctx.shadowBlur = 0
    ctx.strokeStyle = hasIssue ? '#c64f35' : statusColor[position.status]
    ctx.lineWidth = position.id === props.selected ? 3 : 1.5
    ctx.strokeRect(0, 0, PAGE_W, PAGE_H)
    // 出血框（橙虚线）与安全区框（青虚线）
    ctx.strokeStyle = '#df7654'
    ctx.setLineDash([7, 5])
    ctx.strokeRect(-8, -8, PAGE_W + 16, PAGE_H + 16)
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = '#5a9d9b'
    ctx.strokeRect(14, 14, PAGE_W - 28, PAGE_H - 28)
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(48,110,115,.08)'
    ctx.fillRect(18, 18, PAGE_W - 36, PAGE_H - 36)
    ctx.fillStyle = '#31474e'
    ctx.font = 'bold 18px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`P${position.pageNo}`, PAGE_W / 2, PAGE_H / 2 - 10)
    ctx.font = '11px sans-serif'
    ctx.fillStyle = statusColor[position.status]
    const label = position.status === 'confirmed' ? '已确认' : position.status === 'pending' ? '待确认' : '已失效·待重算'
    ctx.fillText(label, PAGE_W / 2, PAGE_H / 2 + 14)
    ctx.restore()
  })
}

function pointerDown(event: PointerEvent) {
  if (!props.interactive) return
  const canvasElement = canvas.value
  if (!canvasElement) return
  const rect = canvasElement.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * W
  const y = ((event.clientY - rect.top) / rect.height) * H
  const hit = props.positions
    .filter((item) => item.front === (props.side === 'front'))
    .find((item) => x >= item.x + 14 && x <= item.x + 14 + PAGE_W && y >= item.y + 24 && y <= item.y + 24 + PAGE_H)
  if (!hit) return
  dragging.value = hit.id
  dragOffset.value = { x: x - hit.x, y: y - hit.y }
  emit('select', hit.id)
  canvasElement.setPointerCapture(event.pointerId)
}

function pointerMove(event: PointerEvent) {
  if (!dragging.value || !canvas.value) return
  const rect = canvas.value.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * W - dragOffset.value.x
  const y = ((event.clientY - rect.top) / rect.height) * H - dragOffset.value.y
  const boundedX = props.clampX ? props.clampX(x) : Math.max(28, Math.min(470, Math.round(x)))
  const boundedY = props.clampY ? props.clampY(y) : Math.max(24, Math.min(580, Math.round(y)))
  emit('update', dragging.value, { x: boundedX, y: boundedY })
}

onMounted(draw)
watch(() => [props.positions, props.side, props.selected, props.validations, props.paperWidth, props.paperHeight, props.paperCode], draw, { deep: true })
</script>

<template>
  <div class="canvas-wrap" :style="{ width: `${Math.round(W * zoom / 100)}px` }">
    <canvas
      ref="canvas"
      :width="W"
      :height="H"
      @pointerdown="pointerDown"
      @pointermove="pointerMove"
      @pointerup="dragging = null"
      @pointercancel="dragging = null"
    />
  </div>
</template>

<style scoped>
.canvas-wrap { width: 800px; max-width: none; transform-origin: left top; transition: width .15s ease; }
canvas { display: block; width: 100%; height: auto; touch-action: none; cursor: grab; }
canvas:active { cursor: grabbing; }
</style>
