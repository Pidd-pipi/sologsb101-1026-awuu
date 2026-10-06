/**
 * 发酵罐 store：维护罐位占用、容量筛选条件与占用冲突校验。
 * 占用事实来自分罐表（splits）：一个罐同一时刻至多一个在罐批次。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Tank, TankState } from '@/types/tank'
import type { FilterModel } from '@/types/filter'
import type { BatchRow, SplitRow, TankRow } from '@/utils/db'
import { assertTankAssignable, putTank, removeTank, updateTank as updateTankRow, ROW_REVISION } from '@/utils/db'
import { createId } from '@/utils/uuid'
import { splitAtTank } from '@/utils/tankOccupancy'
import { queryToFilters } from '@/utils/query'

export const TANK_FILTER_KEYS = ['materials', 'tempControls', 'states']

export const useTankStore = defineStore('tank', () => {
  const filters = ref<FilterModel>({ keyword: '', materials: [], tempControls: [], states: [] })
  const selectedId = ref<string | null>(null)
  const busy = ref(false)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', materials: [], tempControls: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, TANK_FILTER_KEYS)
  }

  function select(id: string | null): void {
    selectedId.value = id
  }

  /** 找出占用该罐的分罐记录（无则返回 null） */
  function splitOccupying(tankId: string, splits: SplitRow[]): SplitRow | null {
    return splitAtTank(splits, tankId)
  }

  /** 找出占用该罐的在罐批次（无则返回 null） */
  function occupancyOf(tankId: string, splits: SplitRow[], batches: BatchRow[]): BatchRow | null {
    const split = splitAtTank(splits, tankId)
    if (!split) return null
    return batches.find((batch) => batch.id === split.batchId && batch.state !== '已出罐') ?? null
  }

  /** 分配前校验：罐位空闲且未被其它在罐批次占用 */
  async function ensureAssignable(tankId: string, batchId: string | null): Promise<void> {
    busy.value = true
    try {
      await assertTankAssignable(tankId, batchId)
    } finally {
      busy.value = false
    }
  }

  async function createTank(payload: Omit<Tank, 'id'>): Promise<string> {
    const now = Date.now()
    const id = createId('tank')
    await putTank({ ...payload, id, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    selectedId.value = id
    return id
  }

  async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
    await updateTankRow(id, patch)
  }

  async function deleteTank(id: string): Promise<void> {
    await removeTank(id)
    if (selectedId.value === id) selectedId.value = null
  }

  /** 罐位状态流转（空闲 ⇄ 清洗中）；置为「在用」需由批次绑定/倒罐触发 */
  async function changeState(tank: TankRow, next: TankState): Promise<void> {
    if (next === '在用') {
      throw new Error('罐位「在用」由入罐 / 倒罐后自动置位，不能手动设置')
    }
    await updateTankRow(tank.id, { state: next })
  }

  return {
    filters,
    selectedId,
    busy,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    splitOccupying,
    occupancyOf,
    ensureAssignable,
    createTank,
    updateTank,
    deleteTank,
    changeState
  }
})
