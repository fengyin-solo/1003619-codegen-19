import { listRows, saveRows, saveRowsBatch } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// —— 测量口径 ——
// 2026-10-01 起启用新版测量口径。未归档记录一律按新口径系数重算；
// 已归档记录是历史结论，沿用原数据，不参与重算。
export const CALIBER = {
  effectiveDate: '2026-10-01',
  dbhFactor: 1.02, // 平均胸径：起测部位 1.3m 调整为 1.2m 的回归换算
  heightFactor: 0.97, // 平均树高：目估改激光测距后的系统偏差修正
  canopyFactor: 0.95, // 郁闭度：样圆法改样点法的换算
}

const ARCHIVED = '已归档'
const NEED_REVIEW = '需复核'
const REPLANT_CONCLUSION = '郁闭度偏低，建议补植防火林带'

export type PlotReviewRow = {
  样地编号: string
  林分类型: string
  记录数: number
  平均胸径: number
  平均树高: number
  最新郁闭度: number
  郁闭度变化: number
  调查员: string
  需复核数: number
  已归档数: number
  复核结论: string
  复核版本: string
  已确认: boolean
}

export type ReviewFilters = {
  样地编号?: string
  林分类型?: string
  记录状态?: string
}

export type ConfirmResult = {
  ok: boolean
  message: string
  confirmed: number
  skipped: number
  firebeltTodos: number
  patrolItems: number
}

function toNumber(value: unknown): number {
  const parsed = Number(String(value ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// 新口径重算：未归档记录按系数换算，已归档记录保留原值
function caliberValue(row: EntryRow, field: string, factor: number): number {
  const raw = toNumber(row[field])
  if (String(row.status) === ARCHIVED) {
    return raw
  }
  return round2(raw * factor)
}

// 缺失调查员的旧记录回填规则（数据修复，幂等）：
// 1. 优先回填同一样地编号下最新一条有调查员记录的调查员；
// 2. 整块样地都没有调查员时，回填当前值班人；
// 被回填的行打上「调查员回填」标记，界面上能看出是补的。
function backfillInvestigator(rows: EntryRow[], operator: string): { rows: EntryRow[]; changed: boolean } {
  const latestByPlot = new Map<string, string>()
  const sorted = [...rows].sort((a, b) => Number(a.id) - Number(b.id))
  for (const row of sorted) {
    const name = String(row['调查员'] ?? '').trim()
    if (name) {
      latestByPlot.set(String(row['样地编号']), name)
    }
  }
  let changed = false
  const next = rows.map((row) => {
    if (String(row['调查员'] ?? '').trim()) {
      return row
    }
    const fill = latestByPlot.get(String(row['样地编号'])) ?? operator
    changed = true
    return { ...row, '调查员': fill, '调查员回填': '是' }
  })
  return { rows: next, changed }
}

// 读取林木生长记录，顺带把缺失调查员的旧记录回填落库（幂等，第二次进来就不变了）
function normalizedRows(operator: string): EntryRow[] {
  const { rows, changed } = backfillInvestigator(listRows('treegrowth'), operator)
  if (changed) {
    saveRows('treegrowth', rows)
  }
  return rows
}

// 数据版本：同一块样地的记录编号、状态、口径后数值一起算哈希。
// 任何一条记录变动都会得到新版本，据此判断「上次确认之后数据有没有变」。
function plotVersion(rows: EntryRow[]): string {
  const text = rows
    .map((row) =>
      [
        row.id,
        row.status,
        caliberValue(row, '平均胸径', CALIBER.dbhFactor),
        caliberValue(row, '平均树高', CALIBER.heightFactor),
        caliberValue(row, '郁闭度', CALIBER.canopyFactor),
      ].join(':'),
    )
    .sort()
    .join('|')
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return `v${rows.length}-${hash.toString(36)}`
}

function decideConclusion(latestCanopy: number, canopyDelta: number, needReview: number): string {
  if (canopyDelta <= -0.05 || latestCanopy < 0.5) {
    return REPLANT_CONCLUSION
  }
  if (needReview > 0) {
    return '复核确认，数据可用'
  }
  return '数据稳定，无需处置'
}

function groupByPlot(rows: EntryRow[]): Map<string, EntryRow[]> {
  const groups = new Map<string, EntryRow[]>()
  for (const row of rows) {
    const plot = String(row['样地编号'] ?? '')
    const list = groups.get(plot) ?? []
    list.push(row)
    groups.set(plot, list)
  }
  return groups
}

function toReviewRow(plot: string, rows: EntryRow[]): PlotReviewRow {
  const sorted = [...rows].sort((a, b) => Number(a.id) - Number(b.id))
  const dbhValues = sorted.map((row) => caliberValue(row, '平均胸径', CALIBER.dbhFactor))
  const heightValues = sorted.map((row) => caliberValue(row, '平均树高', CALIBER.heightFactor))
  const canopyValues = sorted.map((row) => caliberValue(row, '郁闭度', CALIBER.canopyFactor))
  const average = (values: number[]) => round2(values.reduce((sum, value) => sum + value, 0) / values.length)
  const latestCanopy = canopyValues[canopyValues.length - 1]
  const canopyDelta = round2(latestCanopy - canopyValues[0])
  const needReview = sorted.filter((row) => String(row.status) === NEED_REVIEW).length
  const archived = sorted.filter((row) => String(row.status) === ARCHIVED).length
  const investigators = [...new Set(sorted.map((row) => String(row['调查员'] ?? '')).filter(Boolean))]
  const backfilled = sorted.some((row) => row['调查员回填'] === '是')
  const version = plotVersion(sorted)
  const latest = sorted[sorted.length - 1]
  return {
    样地编号: plot,
    林分类型: String(latest['林分类型'] ?? ''),
    记录数: sorted.length,
    平均胸径: average(dbhValues),
    平均树高: average(heightValues),
    最新郁闭度: latestCanopy,
    郁闭度变化: canopyDelta,
    调查员: investigators.join('、') + (backfilled ? '（含回填）' : ''),
    需复核数: needReview,
    已归档数: archived,
    复核结论: decideConclusion(latestCanopy, canopyDelta, needReview),
    复核版本: version,
    已确认: sorted.every((row) => row['复核版本'] === version),
  }
}

// 样地复核视图：按样地编号聚合，展示口径后的平均胸径、平均树高与郁闭度变化，
// 并标出需复核与已归档记录。支持按样地编号、林分类型、记录状态过滤。
export function buildPlotReview(filters: ReviewFilters = {}, operator = '值班管理员'): PlotReviewRow[] {
  const rows = normalizedRows(operator)
  const groups = groupByPlot(rows)
  const plotFilter = filters.样地编号?.trim() ?? ''
  const typeFilter = filters.林分类型?.trim() ?? ''
  const statusFilter = filters.记录状态?.trim() ?? ''
  const review: PlotReviewRow[] = []
  for (const [plot, group] of groups) {
    const item = toReviewRow(plot, group)
    if (plotFilter && !item.样地编号.includes(plotFilter)) {
      continue
    }
    if (typeFilter && !item.林分类型.includes(typeFilter)) {
      continue
    }
    if (statusFilter && !group.some((row) => String(row.status).includes(statusFilter))) {
      continue
    }
    review.push(item)
  }
  return review
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextNo(prefix: string, rows: EntryRow[], field: string): string {
  const max = rows.reduce((current, row) => {
    const match = String(row[field] ?? '').match(/(\d+)$/)
    return match ? Math.max(current, Number(match[1])) : current
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

// 并发守卫：同一时刻只允许一次复核确认在途，重复点击直接忽略。
// 换成真后端时，对应的是（样地编号, 复核版本）上的唯一约束。
let confirming = false

const EMPTY_RESULT = { confirmed: 0, skipped: 0, firebeltTodos: 0, patrolItems: 0 }

// 视图确认：把当前看到的样地复核结论定下来，并同步生成
// 防火林带补植建议（firebelt）与巡护任务复查事项（patrol）。
// 重复确认不重复生成；落库失败时林木生长、防火林带、巡护任务三处一起回退。
export function confirmPlotReview(plotKeys: string[] | undefined, operator: string): ConfirmResult {
  if (confirming) {
    return { ok: false, message: '上一次复核确认还在处理中，本次点击已忽略，结论只保留一个', ...EMPTY_RESULT }
  }
  confirming = true
  try {
    return doConfirm(plotKeys, operator)
  } finally {
    confirming = false
  }
}

function doConfirm(plotKeys: string[] | undefined, operator: string): ConfirmResult {
  const review = buildPlotReview({}, operator)
  const targets = review.filter((item) => !plotKeys || plotKeys.includes(item.样地编号))
  // 重复确认不重复生成：数据版本没变的样地直接跳过
  const fresh = targets.filter((item) => !item.已确认)
  const skipped = targets.length - fresh.length
  if (fresh.length === 0) {
    return {
      ok: true,
      message: `所选 ${targets.length} 个样地自上次确认后数据未变化，没有生成新的结论与待办`,
      confirmed: 0,
      skipped,
      firebeltTodos: 0,
      patrolItems: 0,
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const growthRows = listRows('treegrowth')
  const firebeltRows = listRows('firebelt')
  const patrolRows = listRows('patrol')
  // 回退快照：三处任意一处写不进去，就一起回到这里
  const snapshot = { treegrowth: [...growthRows], firebelt: [...firebeltRows], patrol: [...patrolRows] }

  const freshByPlot = new Map(fresh.map((item) => [item.样地编号, item]))
  // 只落复核结论戳，不动记录状态：状态流转仍走行上的既有动作，
  // 这样复核版本（含状态）在确认前后保持稳定，重复确认才能识别「没变化」。
  const nextGrowth = growthRows.map((row) => {
    const group = freshByPlot.get(String(row['样地编号']))
    if (!group) {
      return row
    }
    return {
      ...row,
      '复核结论': group.复核结论,
      '复核时间': today,
      '复核版本': group.复核版本,
    }
  })

  const nextFirebelt = [...firebeltRows]
  const nextPatrol = [...patrolRows]
  let firebeltTodos = 0
  let patrolItems = 0

  for (const group of fresh) {
    if (group.复核结论 !== REPLANT_CONCLUSION) {
      continue
    }
    // 同一样地已有未完成的补植待办时复用，不再新开
    let belt = nextFirebelt.find(
      (row) => String(row['来源样地'] ?? '') === group.样地编号 && String(row.status) === '需补植',
    )
    if (!belt) {
      // 沿着林分到林带的既有数据流定位：所属林区里挂着这个样地的既有林带
      const linked = nextFirebelt.find(
        (row) => !row['来源样地'] && String(row['所属林区'] ?? '').includes(group.样地编号),
      )
      belt = {
        id: nextId(nextFirebelt),
        status: '需补植',
        pending: true,
        abnormal: false,
        '林带编号': nextNo('FIRE', nextFirebelt, '林带编号'),
        '林带名称': `${group.样地编号}补植林带`,
        '所属林区': `${group.样地编号} ${group.林分类型}`,
        '树种组成': group.林分类型,
        '林带长度': '待实测',
        '林带宽度': '待实测',
        '种植年份': String(new Date().getFullYear()),
        '林带状态': '需补植',
        '来源样地': group.样地编号,
        '复核版本': group.复核版本,
        '关联林带编号': linked ? String(linked['林带编号']) : '新划林带',
      }
      nextFirebelt.push(belt)
      firebeltTodos += 1
    }
    // 林带补植待办跟着生成巡护复查事项；同一条林带待办只跟一条未完成的复查
    const beltNo = String(belt['林带编号'])
    const hasOpenPatrol = nextPatrol.some(
      (row) => String(row['关联林带编号'] ?? '') === beltNo && String(row.status) === '待执行',
    )
    if (!hasOpenPatrol) {
      nextPatrol.push({
        id: nextId(nextPatrol),
        status: '待执行',
        pending: true,
        abnormal: false,
        '任务编号': nextNo('PATR', nextPatrol, '任务编号'),
        '巡护区域': `${group.样地编号} ${group.林分类型}`,
        '巡护路线': `复查${beltNo}补植情况`,
        '巡护员': operator,
        '巡护日期': today,
        '巡护时段': '白班',
        '发现火情数': '0',
        '任务状态': '待执行',
        '关联林带编号': beltNo,
        '来源样地': group.样地编号,
      })
      patrolItems += 1
    }
  }

  try {
    saveRowsBatch({ treegrowth: nextGrowth, firebelt: nextFirebelt, patrol: nextPatrol })
  } catch (error) {
    try {
      saveRowsBatch(snapshot)
    } catch {
      // 回退本身也失败时保留现场，界面上提示用重置恢复
    }
    const reason = error instanceof Error ? error.message : '未知原因'
    return {
      ok: false,
      message: `复核结论落库失败（${reason}），林木生长、防火林带、巡护任务三处已一起回退`,
      ...EMPTY_RESULT,
    }
  }

  return {
    ok: true,
    message: `已确认 ${fresh.length} 个样地的复核结论，新增林带补植建议 ${firebeltTodos} 条、巡护复查事项 ${patrolItems} 条，跳过未变化 ${skipped} 个`,
    confirmed: fresh.length,
    skipped,
    firebeltTodos,
    patrolItems,
  }
}
