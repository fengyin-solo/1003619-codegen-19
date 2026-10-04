<template>
  <div>
    <div class="page-actions" style="margin-bottom: 12px">
      <button class="btn primary" type="button" @click="openCreate">登记林木生长记录</button>
      <button class="btn" type="button" @click="exportRows">导出林木生长清单</button>
    </div>

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
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('treegrowth')
const columns = ["记录编号", "样地编号", "林分类型", "调查日期", "平均胸径", "平均树高", "郁闭度", "调查员", "记录状态"]
const actions = ["提交审核", "确认记录", "要求复核"]
const statuses = ["已录入", "已审核", "需复核", "已归档"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => {
  const plots = new Set(rows.value.map((row) => String(row['样地编号'] ?? '')))
  const month = new Date().toISOString().slice(0, 7)
  return [
    { label: '样地数量', value: plots.size },
    { label: '待审核记录', value: rows.value.filter((row) => String(row.status) === '需复核').length },
    { label: '本月录入', value: rows.value.filter((row) => String(row['调查日期'] ?? '').startsWith(month)).length },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 郁闭度以两位小数展示，胸径树高保留一位，复核后可能并存「原始…」留痕字段。
function formatCell(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === null || value === '') {
    return column === '调查员' ? '—（待回填）' : '—'
  }
  if (column === '郁闭度') {
    return Number(value).toFixed(2)
  }
  if (column === '平均胸径' || column === '平均树高') {
    return Number(value).toFixed(1)
  }
  return String(value)
}

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

onMounted(reload)
</script>
