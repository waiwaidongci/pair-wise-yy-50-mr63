<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import PaperChangeDialog from '../components/PaperChangeDialog.vue'
import { useImpositionStore } from '../stores/imposition'

const store = useImpositionStore()
const errors = computed(() => store.validations.filter((item) => item.severity === '错误').length)
const pendingProof = computed(() => store.proofs.find((proof) => proof.decision === '待决定'))
const staleProofs = computed(() => store.proofs.filter((proof) => proof.stale).length)
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">PRINT PRODUCTION / 印刷生产</p><h1>拼版预检与打样总览</h1><p class="muted">在当前拼版版本进入生产前，集中处理页序、出血、色彩与装订风险。</p></div>
      <div class="actions"><Button label="运行完整预检" icon="pi pi-check-circle" outlined /><Button label="进入拼版工作区" icon="pi pi-th-large" @click="$router.push('/imposition')" /></div>
    </div>

    <div class="metric-grid">
      <article class="metric"><span>页面文件</span><strong>{{ store.pages.length }}</strong><small>{{ store.positions.length }} 个已排版位</small></article>
      <article class="metric"><span>预检错误</span><strong class="error">{{ errors }}</strong><small>必须处理后方可锁定</small></article>
      <article class="metric"><span>打样轮次</span><strong>{{ store.proofs.length }}</strong><small>当前 ΔE {{ pendingProof?.deltaE ?? '—' }}</small></article>
      <article class="metric"><span>待恢复导出</span><strong>{{ store.tasks.filter((task) => task.resumable && task.status !== '已完成').length }}</strong><small>断点可继续</small></article>
    </div>

    <section class="panel batch-panel">
      <div class="panel-head">
        <h3>纸张批次</h3>
        <Button label="登记新批次 / 换纸" icon="pi pi-refresh" size="small" @click="store.openPaperDialog" />
      </div>
      <div class="batch-current">
        <div class="batch-id">
          <strong>{{ store.currentBatch?.id }}</strong>
          <Tag value="当前批次" severity="success" />
          <Tag value="规格已冻结" severity="info" icon="pi pi-lock" />
        </div>
        <div class="batch-specs">
          <span>纸宽 <b>{{ store.currentBatch?.width }}</b> mm</span>
          <span>纸高 <b>{{ store.currentBatch?.height }}</b> mm</span>
          <span>克重 <b>{{ store.currentBatch?.grammage }}</b> g/m²</span>
          <span>纸纹 <b>{{ store.currentBatch?.grain }}</b></span>
        </div>
        <small>登记于 {{ store.currentBatch?.registeredAt }} · {{ store.currentBatch?.registeredBy }}</small>
      </div>
      <div class="batch-history">
        <div v-for="batch in store.paperBatches.filter((item) => item.status === '历史')" :key="batch.id" class="batch-row">
          <strong>{{ batch.id }}</strong>
          <span>{{ batch.width }} × {{ batch.height }}mm · {{ batch.grammage }}g/m² · {{ batch.grain }}</span>
          <small>{{ batch.registeredAt }} · {{ batch.registeredBy }}</small>
        </div>
      </div>
      <div v-if="staleProofs" class="batch-note">
        <i class="pi pi-exclamation-triangle" />
        <span>{{ staleProofs }} 轮打样依据旧批次，换纸后结论待复核；受影响跨页组的导出分片需重算，其余分片依据一致时复用。</span>
      </div>
    </section>

    <div class="overview-grid">
      <section class="panel">
        <div class="panel-head"><h3>当前拼版任务</h3><Tag :value="store.revision" severity="info" /></div>
        <div class="project-card">
          <div>
            <strong>《潮汐来信》上海巡演节目册</strong>
            <p>成品 210 × 297mm · 8P · 骑马订 · 720 × 1020mm 对开纸</p>
            <div class="specs"><span>CMYK + 专色</span><span>纵向纸纹</span><span>PDF/X-4</span><span>色彩控制条已配置</span></div>
          </div>
          <Button label="打开拼版" icon="pi pi-arrow-right" @click="$router.push('/imposition')" />
        </div>
        <div class="checklist">
          <div><i class="pi pi-check-circle" /><span>页面尺寸与成品规格</span><Tag value="通过" severity="success" /></div>
          <div><i class="pi pi-exclamation-triangle warn" /><span>折手与页码顺序</span><Tag value="1 项警告" severity="warn" /></div>
          <div><i class="pi pi-times-circle error" /><span>出血与版位安全区</span><Tag :value="`${errors} 项错误`" severity="danger" /></div>
          <div><i class="pi pi-check-circle" /><span>色彩控制条与纸张规格</span><Tag value="通过" severity="success" /></div>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>最近打样</h3><Button label="查看全部" text size="small" @click="$router.push('/proofs')" /></div>
          <div class="proof-summary">
            <template v-for="proof in store.proofs.slice().reverse()" :key="proof.id">
              <div class="proof-row">
                <div><strong>第 {{ proof.round }} 轮 · {{ proof.sample }}</strong><small>{{ proof.date }} · ΔE {{ proof.deltaE }}</small></div>
                <Tag :value="proof.decision" :severity="proof.decision === '通过' ? 'success' : proof.decision === '退回' ? 'danger' : 'warn'" />
              </div>
            </template>
          </div>
        </section>
        <section class="panel export-mini">
          <div class="panel-head"><h3>导出任务</h3></div>
          <div v-for="task in store.tasks" :key="task.id">
            <div><span>{{ task.name }}</span><strong>{{ task.progress }}%</strong></div>
            <ProgressBar :value="task.progress" :showValue="false" :style="{ height: '7px' }" />
            <small>{{ task.status }} · {{ task.updatedAt }}</small>
          </div>
        </section>
      </aside>
    </div>

    <PaperChangeDialog />
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.metric .error { color: #b84e35; }
.overview-grid { display: grid; grid-template-columns: minmax(0,1fr) 350px; gap: 14px; align-items: start; }
.project-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px; }
.project-card strong { font-size: 17px; }
.project-card p { margin: 7px 0 14px; color: #66757c; }
.specs { display: flex; flex-wrap: wrap; gap: 7px; }
.specs span { padding: 5px 8px; border-radius: 5px; color: #45676d; background: #eef4f4; font-size: 10px; }
.checklist { padding: 0 18px 16px; }
.checklist > div { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 9px; padding: 11px 0; border-top: 1px solid #ecf0f0; font-size: 12px; }
.checklist i { color: #3b8a67; }
.checklist i.warn { color: #c4872f; }
.checklist i.error { color: #bb4c35; }
aside { display: grid; gap: 14px; }
.proof-summary { padding: 8px 16px 14px; }
.proof-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-bottom: 1px solid #edf1f1; }
.proof-row strong, .proof-row small { display: block; }
.proof-row small { margin-top: 4px; color: #7a878d; font-size: 10px; }
.export-mini > div:not(.panel-head) { padding: 11px 16px 4px; }
.export-mini > div > div { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 11px; }
.export-mini small { display: block; margin-top: 5px; color: #7d898e; }
.batch-panel { margin-bottom: 14px; }
.batch-current { padding: 4px 18px 12px; }
.batch-id { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.batch-id strong { font-size: 15px; }
.batch-specs { display: flex; flex-wrap: wrap; gap: 18px; font-size: 12px; color: #5d7077; }
.batch-specs b { color: #2f464d; font-size: 14px; }
.batch-current small { display: block; margin-top: 8px; color: #8a979b; font-size: 10px; }
.batch-history { padding: 0 18px 14px; }
.batch-row { display: flex; align-items: baseline; gap: 12px; padding: 8px 0; border-top: 1px solid #ecf0f0; font-size: 12px; }
.batch-row strong { color: #45676d; }
.batch-row span { color: #5d7077; }
.batch-row small { margin-left: auto; color: #8a979b; font-size: 10px; }
.batch-note { display: flex; align-items: center; gap: 8px; margin: 0 18px 16px; padding: 10px 12px; border-left: 3px solid #c98236; border-radius: 6px; background: #fff5e8; color: #716555; font-size: 11px; }
@media (max-width: 1050px) { .overview-grid { grid-template-columns: 1fr; } }
</style>
