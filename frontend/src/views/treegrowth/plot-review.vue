<template>
  <div>
    <div class="review-banner">
      <div>
        <strong>样地复核视图</strong>
        <span class="banner-desc">
          按样地编号、林分类型、记录状态组织多期调查记录，展示平均胸径、平均树高与郁闭度变化。
          已归档记录沿用 2021 旧口径原数据；未归档记录按 2026 新口径重算（胸径 ×{{ dbhFactor }}、郁闭度 ×{{ canopyFactor }}、树高不变）。
        </span>
      </div>
    </div>

    <div class="stat-row">
      <article v-for="item in summary" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>样地编号</span>
        <input v-model="filters.plotId" placeholder="按样地编号检索" />
      </label>
      <label class="filter-item">
        <span>林分类型</span>
        <input v-model="filters.standType" placeholder="按林分类型检索" />
      </label>
      <label class="filter-item">
        <span>记录状态</span>
        <select v-model="filters.status">
          <option value="">全部状态</option>
          <option v-for="status in statusOptions" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="demo-bar">
      <label class="demo-item">
        <input v-model="failPersistence" type="checkbox" />
        <span>下次确认模拟落库失败（验证三处一起回退）</span>
      </label>
      <button class="btn ghost" type="button" :disabled="!firstNeedReviewId || busy" @click="runConcurrentDemo">
        并发复核演示（同一记录确认两次）
      </button>
    </div>

    <p v-if="message" class="result-line" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</p>

    <article v-for="group in groups" :key="group.plotId" class="plot-card">
      <header class="plot-head">
        <div class="plot-title">
          <h3>{{ group.plotId }} · {{ group.standType }}</h3>
          <span class="plot-meta">
            关联林带：
            <strong>{{ group.belt.belt ? group.belt.belt['林带编号'] : '未分派' }}</strong>
            {{ group.belt.belt ? group.belt.belt['林带名称'] : '' }}
            <em :class="group.belt.matched ? 'match-ok' : 'match-warn'">（{{ group.belt.reason }}）</em>
          </span>
        </div>
        <div class="plot-advice">
          <span class="badge" :class="`advice-${group.advice.action}`">{{ group.advice.label }}</span>
          <span class="advice-reason">{{ group.advice.reason }}</span>
        </div>
      </header>

      <table class="data-table">
        <thead>
          <tr>
            <th>调查日期</th>
            <th>记录编号</th>
            <th>平均胸径(cm)</th>
            <th>平均树高(m)</th>
            <th>郁闭度</th>
            <th>调查员</th>
            <th>口径</th>
            <th>记录状态</th>
            <th>复核操作 / 结论</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in group.records" :key="item.recordNo">
            <td>{{ item.date }}</td>
            <td>{{ item.recordNo }}</td>
            <td v-for="field in metricFields" :key="field">
              <div class="metric-cell">
                <span class="metric-value">{{ formatEffective(item, field) }}</span>
                <span
                  v-if="metricOf(item, field).recalibrated"
                  class="metric-raw"
                  :title="`原口径值 ${formatRaw(item, field)}`"
                >(原 {{ formatRaw(item, field) }})</span>
                <span
                  v-if="metricOf(item, field).delta !== null"
                  class="delta"
                  :class="deltaClass(metricOf(item, field).delta)"
                >{{ deltaText(metricOf(item, field).delta) }}</span>
                <span v-if="metricOf(item, field).caliberSwitched" class="badge badge-switch">跨口径比较</span>
              </div>
            </td>
            <td>
              {{ item.investigator || '—' }}
              <span v-if="item.investigatorMissing" class="badge badge-warn">
                缺调查员，确认时{{ item.backfill?.source }}：{{ item.backfill?.investigator }}
              </span>
            </td>
            <td>
              <span class="badge" :class="item.archived ? 'badge-old' : 'badge-new'">
                {{ item.caliber === '2021旧口径' ? '旧口径·原数据' : '新口径重算' }}
              </span>
            </td>
            <td>
              <span v-if="item.archived" class="badge badge-archived">已归档</span>
              <span v-else-if="item.needReview" class="badge badge-review">需复核</span>
              <span v-else class="badge badge-normal">{{ item.row.status }}</span>
            </td>
            <td>
              <template v-if="item.confirmed">
                <span class="conclusion">{{ item.conclusion }}</span>
                <span class="conclusion-by">{{ item.row['复核人'] }} · {{ item.row['复核时间'] }}</span>
              </template>
              <button
                v-else-if="item.needReview"
                class="btn primary small"
                type="button"
                :disabled="busy"
                @click="confirm(item)"
              >
                确认复核
              </button>
              <span v-else class="muted-text">—</span>
            </td>
          </tr>
        </tbody>
      </table>

      <footer v-if="group.generated" class="generated-box">
        <strong>已同步生成（批次 {{ group.generated.batchKey }}，重复确认不再生成）：</strong>
        <ul>
          <li v-if="group.generated.beltSuggestion">
            防火林带{{ group.generated.beltSuggestion['建议措施'] }}建议
            {{ group.generated.beltSuggestion['林带编号'] }}：
            {{ group.generated.beltSuggestion['建议依据'] }}
          </li>
          <li v-for="task in group.generated.patrolItems" :key="String(task.id)">
            {{ task['事项类型'] }} {{ task['任务编号'] }}：{{ task['事项说明'] }}
          </li>
        </ul>
      </footer>
    </article>

    <p v-if="!groups.length" class="empty-state" style="padding: 24px">没有符合筛选条件的样地记录</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { confirmReview, buildReviewView } from '@/api/plot-review'
import type { PlotGroup, RecordReview, ReviewMetric } from '@/api/plot-review'

const dbhFactor = 0.98
const canopyFactor = 0.95
const statusOptions = ['已录入', '已审核', '需复核', '已归档']
// 表头顺序：平均胸径、平均树高、郁闭度，模板按这个顺序展开指标列。
const metricFields: ReviewMetric['field'][] = ['平均胸径', '平均树高', '郁闭度']

const groups = ref<PlotGroup[]>([])
const summary = ref<{ label: string; value: number }[]>([])
const filters = ref<{ plotId: string; standType: string; status: string }>({
  plotId: '',
  standType: '',
  status: '',
})
const message = ref('')
const messageOk = ref(false)
const busy = ref(false)
const failPersistence = ref(false)

const firstNeedReviewId = computed(() => {
  for (const group of groups.value) {
    const target = group.records.find((r) => r.needReview && !r.confirmed)
    if (target) {
      return Number(target.row.id)
    }
  }
  return 0
})

function metricOf(item: RecordReview, field: ReviewMetric['field']): ReviewMetric {
  return item.metrics.find((m) => m.field === field)!
}

// 指标格：展示当前有效值与相对上一期的变化，跨口径比较时给出提示。
function formatEffective(item: RecordReview, field: ReviewMetric['field']): string {
  const metric = metricOf(item, field)
  return metric.effective.toFixed(metric.precision) + metric.unit
}

function formatRaw(item: RecordReview, field: ReviewMetric['field']): string {
  const metric = metricOf(item, field)
  return metric.raw.toFixed(metric.precision) + metric.unit
}

function deltaText(delta: number | null): string {
  if (delta === null) {
    return ''
  }
  if (delta > 0) {
    return `▲ ${Math.abs(delta)}`
  }
  if (delta < 0) {
    return `▼ ${Math.abs(delta)}`
  }
  return '持平'
}

function deltaClass(delta: number | null): string {
  if (delta === null) {
    return ''
  }
  if (delta === 0) {
    return 'delta-flat'
  }
  return delta > 0 ? 'delta-up' : 'delta-down'
}

function resetFilters() {
  filters.value = { plotId: '', standType: '', status: '' }
  reload()
}

function reload() {
  const payload = buildReviewView({
    plotId: filters.value.plotId.trim(),
    standType: filters.value.standType.trim(),
    status: filters.value.status,
  })
  groups.value = payload.groups
  summary.value = payload.summary
}

async function confirm(item: RecordReview) {
  if (busy.value) {
    return
  }
  busy.value = true
  message.value = ''
  try {
    const result = await confirmReview(Number(item.row.id), { failPersistence: failPersistence.value })
    messageOk.value = result.ok
    message.value = result.message
    if (failPersistence.value) {
      failPersistence.value = false
    }
    reload()
  } finally {
    busy.value = false
  }
}

// 并发复核：同一条需复核记录几乎同时确认两次，只有一个能留下结论。
async function runConcurrentDemo() {
  if (!firstNeedReviewId.value || busy.value) {
    return
  }
  busy.value = true
  message.value = '并发复核进行中…'
  messageOk.value = true
  const id = firstNeedReviewId.value
  const [first, second] = await Promise.all([
    confirmReview(id, { failPersistence: failPersistence.value }),
    confirmReview(id, { failPersistence: failPersistence.value }),
  ])
  const results = [first, second]
  const okCount = results.filter((r) => r.ok).length
  messageOk.value = okCount === 1
  message.value = `并发两次确认：${okCount === 1 ? '仅 1 个结论落库（' : `${okCount} 个成功（异常），`}
    成功：「${results.find((r) => r.ok)?.message ?? '无'}」；
    被拒：「${results.find((r) => !r.ok)?.message ?? '无'}」)`
  failPersistence.value = false
  reload()
  busy.value = false
}

onMounted(reload)
</script>

<style scoped>
.review-banner {
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
}
.banner-desc {
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin-top: 4px;
  line-height: 1.6;
}
.tab-bar {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.tab-item {
  border: none;
  background: none;
  padding: 8px 16px;
  cursor: pointer;
  font-size: 14px;
  color: var(--muted);
  border-bottom: 2px solid transparent;
}
.tab-item.active {
  color: var(--brand);
  border-bottom-color: var(--brand);
  font-weight: 600;
}
.demo-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 10px;
  font-size: 12px;
}
.demo-item {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}
.result-line {
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 6px;
  background: #f8fafc;
}
.ok-text {
  color: #067647;
}
.plot-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 16px;
}
.plot-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.plot-title h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.plot-meta {
  font-size: 12px;
  color: var(--muted);
}
.match-ok {
  color: #067647;
  font-style: normal;
}
.match-warn {
  color: #b54708;
}
.plot-advice {
  text-align: right;
}
.advice-reason {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
  max-width: 340px;
}
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 1.6;
  margin-left: 4px;
}
.badge-review {
  background: #fff4ed;
  color: #b93815;
}
.badge-archived {
  background: #f2f4f7;
  color: #475467;
}
.badge-normal {
  background: #eef4ff;
  color: #1849a9;
}
.badge-old {
  background: #f2f4f7;
  color: #667085;
}
.badge-new {
  background: #ecfdf3;
  color: #067647;
}
.badge-warn {
  background: #fffaeb;
  color: #b54708;
}
.badge-switch {
  background: #f4ebff;
  color: #6941c6;
}
.advice-replant {
  background: #fef3f2;
  color: #b42318;
}
.advice-observe {
  background: #fffaeb;
  color: #b54708;
}
.advice-tend {
  background: #ecfdf3;
  color: #067647;
}
.btn.small {
  padding: 3px 10px;
  font-size: 12px;
}
.metric-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.metric-value {
  font-weight: 600;
}
.metric-raw {
  font-size: 11px;
  color: var(--muted);
}
.delta {
  font-size: 11px;
}
.delta-up {
  color: #b42318;
}
.delta-down {
  color: #067647;
}
.delta-flat {
  color: var(--muted);
}
.conclusion {
  display: block;
  font-size: 12px;
  color: #067647;
}
.conclusion-by {
  display: block;
  font-size: 11px;
  color: var(--muted);
}
.muted-text {
  color: var(--muted);
}
.generated-box {
  margin-top: 10px;
  background: #f8fafc;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
}
.generated-box ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.generated-box li {
  margin: 2px 0;
}
</style>
