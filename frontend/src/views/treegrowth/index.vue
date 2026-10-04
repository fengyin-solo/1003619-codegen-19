<template>
  <section class="page" data-module="treegrowth">
    <header class="page-head">
      <div>
        <h2>林木生长管理</h2>
        <p class="page-desc">维护林木生长记录，围绕记录编号、样地编号、林分类型、平均胸径做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记林木生长记录</button>
        <button class="btn" type="button" @click="exportRows">导出林木生长清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无林木生长数据，可先登记林木生长记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条林木生长记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="review-panel">
      <header class="page-head">
        <div>
          <h3>样地复核视图</h3>
          <p class="page-desc">
            按样地编号、林分类型、记录状态汇总；未归档记录已按 {{ caliber.effectiveDate }} 新口径重算，已归档记录沿用原数据。
          </p>
        </div>
        <div class="page-actions">
          <button class="btn primary" type="button" :disabled="confirming" @click="confirmReview">
            {{ confirming ? '正在确认…' : '确认复核视图' }}
          </button>
        </div>
      </header>

      <form class="filter-bar" @submit.prevent="reloadReview">
        <label class="filter-item">
          <span>样地编号</span>
          <input v-model="reviewFilters.样地编号" placeholder="按样地编号检索" />
        </label>
        <label class="filter-item">
          <span>林分类型</span>
          <input v-model="reviewFilters.林分类型" placeholder="按林分类型检索" />
        </label>
        <label class="filter-item">
          <span>记录状态</span>
          <input v-model="reviewFilters.记录状态" placeholder="按记录状态检索" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetReviewFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th>样地编号</th>
            <th>林分类型</th>
            <th>记录数</th>
            <th>平均胸径(cm)</th>
            <th>平均树高(m)</th>
            <th>最新郁闭度</th>
            <th>郁闭度变化</th>
            <th>调查员</th>
            <th>记录标记</th>
            <th>复核结论</th>
            <th>确认状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in reviewRows" :key="item.样地编号">
            <td>{{ item.样地编号 }}</td>
            <td>{{ item.林分类型 }}</td>
            <td>{{ item.记录数 }}</td>
            <td>{{ item.平均胸径 }}</td>
            <td>{{ item.平均树高 }}</td>
            <td>{{ item.最新郁闭度 }}</td>
            <td :class="item.郁闭度变化 < 0 ? 'delta-down' : 'delta-up'">
              {{ item.郁闭度变化 > 0 ? `+${item.郁闭度变化}` : item.郁闭度变化 }}
            </td>
            <td>{{ item.调查员 || '—' }}</td>
            <td>
              <span v-if="item.需复核数" class="tag warn">需复核 {{ item.需复核数 }}</span>
              <span v-if="item.已归档数" class="tag done">已归档 {{ item.已归档数 }}</span>
              <span v-if="!item.需复核数 && !item.已归档数">—</span>
            </td>
            <td>{{ item.复核结论 }}</td>
            <td>
              <span v-if="item.已确认" class="tag done">已确认 {{ item.复核版本 }}</span>
              <span v-else class="tag warn">待确认</span>
            </td>
          </tr>
          <tr v-if="!reviewRows.length">
            <td colspan="11" class="empty-state">暂无符合条件的样地复核数据</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>确认后将同步生成防火林带补植建议与巡护复查事项，重复确认不重复生成</span>
        <span v-if="reviewMessage" :class="reviewOk ? '' : 'error-text'">{{ reviewMessage }}</span>
      </footer>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  CALIBER as caliber,
  buildPlotReview,
  confirmPlotReview,
  type PlotReviewRow,
} from '@/api/plot-review'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('treegrowth')
const columns = ["记录编号", "样地编号", "林分类型", "平均胸径", "平均树高", "郁闭度", "调查员", "记录状态"]
const actions = ["提交审核", "确认记录", "要求复核"]
const statuses = ["已录入", "已审核", "需复核", "已归档"]
const stats = [{"label": "样地数量", "value": 0}, {"label": "待审核记录", "value": 0}, {"label": "本月录入", "value": 0}]

const store = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const reviewRows = ref<PlotReviewRow[]>([])
const reviewFilters = ref({ 样地编号: '', 林分类型: '', 记录状态: '' })
const reviewMessage = ref('')
const reviewOk = ref(true)
const confirming = ref(false)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '林木生长记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  reloadReview()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '林木生长列表读取失败'
  }
}

function reloadReview() {
  reviewMessage.value = ''
  try {
    reviewRows.value = buildPlotReview(reviewFilters.value, store.operator)
  } catch (error) {
    reviewOk.value = false
    reviewMessage.value = error instanceof Error ? error.message : '样地复核视图读取失败'
  }
}

function resetReviewFilters() {
  reviewFilters.value = { 样地编号: '', 林分类型: '', 记录状态: '' }
  reloadReview()
}

function confirmReview() {
  if (confirming.value) {
    return
  }
  confirming.value = true
  try {
    const plotKeys = reviewRows.value.map((item) => item.样地编号)
    const result = confirmPlotReview(plotKeys, store.operator)
    reviewOk.value = result.ok
    reviewMessage.value = result.message
  } finally {
    confirming.value = false
  }
  reload()
  reloadReview()
}

onMounted(() => {
  reload()
  reloadReview()
})
</script>
