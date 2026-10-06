/**
 * 入罐批次 store：维护在罐批次、当前选中批次与地块/罐绑定校验。
 * 在罐量与罐位占用以分罐表（splits）为准，由 db 层事务维护。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Batch } from '@/types/batch'
import type { FilterModel } from '@/types/filter'
import {
  assignBatchToTank as assignBatchToTankRow,
  intakeBatch,
  removeBatch,
  shipBatch as shipBatchRow,
  updateBatch as updateBatchRow
} from '@/utils/db'
import { queryToFilters } from '@/utils/query'

export const BATCH_FILTER_KEYS = ['states', 'parcelIds']

export const useBatchStore = defineStore('batch', () => {
  const filters = ref<FilterModel>({ keyword: '', states: [], parcelIds: [] })
  /** 当前选中的批次 id（读数页、作业页、倒罐对话框共用上下文） */
  const currentBatchId = ref<string | null>(null)
  const error = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', states: [], parcelIds: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, BATCH_FILTER_KEYS)
    if (typeof query.batchId === 'string' && query.batchId.length > 0) {
      currentBatchId.value = query.batchId
    }
  }

  function select(id: string | null): void {
    currentBatchId.value = id
  }

  /** 入罐登记：原子事务写批次 + 首条分罐 + 罐位「在用」（容量不够会提示改用倒罐拆分） */
  async function createBatch(payload: Omit<Batch, 'id' | 'lastOperationAt'>): Promise<string> {
    error.value = null
    if (!payload.parcelId) throw new Error('请选择地块')
    if (!payload.tankId) throw new Error('请选择发酵罐')
    const id = await intakeBatch(payload)
    currentBatchId.value = id
    return id
  }

  /** 通用字段更新（罐位改绑请走 assignToTank / 倒罐，保证分罐与罐位一致） */
  async function updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
    error.value = null
    await updateBatchRow(id, patch)
  }

  /** 整批改绑到另一罐：冲突 / 容量校验、分罐迁移与罐位置位在单事务内完成 */
  async function assignToTank(tankId: string, batchId: string): Promise<void> {
    error.value = null
    await assignBatchToTankRow(tankId, batchId)
  }

  async function deleteBatch(id: string): Promise<void> {
    await removeBatch(id)
    if (currentBatchId.value === id) currentBatchId.value = null
  }

  /** 出罐：清空分罐、释放全部占用罐位并归档批次 */
  async function ship(id: string): Promise<void> {
    await shipBatchRow(id)
  }

  return {
    filters,
    currentBatchId,
    error,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    createBatch,
    updateBatch,
    assignToTank,
    deleteBatch,
    ship
  }
})
