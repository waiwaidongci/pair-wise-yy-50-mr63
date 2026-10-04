<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import { useImpositionStore } from '../stores/imposition'

const store = useImpositionStore()
const errors = computed(() => store.validations.filter((item) => item.severity === '错误').length)
const pendingProof = computed(() => store.proofs.find((proof) => proof.decision === '待决定'))
const invalidatedCount = computed(() => store.positions.filter((p) => p.status === 'invalidated').length)
const pendingReviewCount = computed(() => store.tasks.filter((task) => task.status === '待复核').length)
const staleProofCount = computed(() => store.proofs.filter((proof) => store.proofBasisState(proof) === '旧依据').length)
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">PRINT PRODUCTION / 印刷生产</p><h1>拼版预检与打样总览</h1><p class="muted">在当前拼版版本进入生产前，集中处理页序、出血、色彩与装订风险。</p></div>
      <div class="actions"><Button label="运行完整预检" icon="pi pi-check-circle" outlined /><Button label="进入拼版工作区" icon="pi pi-th-large" @click="$router.push('/imposition')" /></div>
    </div>

    <div class="metric-grid">
      <article class="metric"><span>在用纸批次</span><strong class="batch">{{ store.activeBatch.code }}</strong><small>{{ store.activeBatch.width }}×{{ store.activeBatch.height }}mm · {{ store.activeBatch.gsm }}g</small></article>
      <article class="metric"><span>预检错误</span><strong class="error">{{ errors }}</strong><small>{{ invalidatedCount }} 个版位换纸失效待重算</small></article>
      <article class="metric"><span>打样依据</span><strong :class="staleProofCount ? 'warn-num' : ''">{{ store.proofs.length }} 轮</strong><small>{{ staleProofCount }} 轮基于旧纸批次</small></article>
      <article class="metric"><span>待复核 / 待恢复</span><strong>{{ pendingReviewCount }} / {{ store.tasks.filter((task) => task.resumable && task.status !== '已完成' && task.status !== '待复核').length }}</strong><small>缺依据先待复核，不续传</small></article>
    </div>

    <div class="overview-grid">
      <section class="panel">
        <div class="panel-head"><h3>当前拼版任务</h3><Tag :value="store.revision" severity="info" /></div>
        <div class="project-card">
          <div>
            <strong>《潮汐来信》上海巡演节目册</strong>
            <p>成品 210 × 297mm · 8P · 骑马订 · {{ store.activeBatch.width }} × {{ store.activeBatch.height }}mm 对开纸 · {{ store.activeBatch.gsm }}g</p>
            <div class="specs"><span>CMYK + 专色</span><span>纵向纸纹</span><span>PDF/X-4</span><span>用纸 {{ store.activeBatch.code }}</span></div>
          </div>
          <Button label="纸张批次/换纸" icon="pi pi-box" @click="$router.push('/paper')" />
        </div>
        <div class="checklist">
          <div><i class="pi pi-check-circle" /><span>页面尺寸与成品规格</span><Tag value="通过" severity="success" /></div>
          <div><i class="pi pi-exclamation-triangle warn" /><span>折手与页码顺序</span><Tag value="1 项警告" severity="warn" /></div>
          <div><i :class="errors ? 'pi pi-times-circle error' : 'pi pi-check-circle'" /><span>出血、安全区与换纸失效重算</span><Tag :value="`${errors} 项错误`" :severity="errors ? 'danger' : 'success'" /></div>
          <div><i class="pi pi-check-circle" /><span>色彩控制条与纸张冻结规格</span><Tag :value="store.activeBatch.code" severity="success" /></div>
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
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.metric .error { color: #b84e35; }
.metric .batch { font-size: 20px; color: #337b79; }
.metric .warn-num { color: #bf7f2c; }
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
@media (max-width: 1050px) { .overview-grid { grid-template-columns: 1fr; } }
</style>
