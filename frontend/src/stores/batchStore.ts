/**
 * 入罐批次 store：维护在罐批次、当前选中批次与地块/罐绑定校验。
 * 入罐登记在同一事务内写批次与分罐占用并置位罐位；出罐释放分罐与罐位。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Batch } from '@/types/batch'
import type { FilterModel } from '@/types/filter'
import type { BatchRow } from '@/utils/db'
import {
  assertTankAssignable,
  db,
  putBatch,
  reconcileTankStates,
  removeBatch,
  shipBatch as shipBatchRow,
  updateBatch as updateBatchRow,
  RACK_VERSION_KEY,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const BATCH_FILTER_KEYS = ['states', 'parcelIds']

export const useBatchStore = defineStore('batch', () => {
  const filters = ref<FilterModel>({ keyword: '', states: [], parcelIds: [] })
  /** 当前选中的批次 id（读数页、作业页共用上下文） */
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

  /** 入罐登记：先校验罐位可分配，再在同一事务内写批次、分罐占用并把罐置为「在用」 */
  async function createBatch(payload: Omit<Batch, 'id' | 'lastOperationAt'>): Promise<string> {
    error.value = null
    if (!payload.parcelId) throw new Error('请选择地块')
    if (!payload.tankId) throw new Error('请选择发酵罐')
    if (!(payload.volumeL > 0)) throw new Error('入罐量必须大于 0')
    await assertTankAssignable(payload.tankId, null)
    const now = Date.now()
    const id = createId('batch')
    await db.transaction('rw', [db.batches, db.tanks, db.tankAllocations, db.meta], async () => {
      // 事务内最终复核：防止两个页面同时把不同批次入到同一个空罐
      const occupants = await db.tankAllocations.where('tankId').equals(payload.tankId).count()
      if (occupants > 0) throw new Error('该罐位刚被其它批次占用，请刷新后重选')
      await putBatch({ ...payload, id, lastOperationAt: null, revision: ROW_REVISION, createdAt: now, updatedAt: now })
      await db.tankAllocations.add({
        id: `alloc-${id}-${payload.tankId}`,
        batchId: id,
        tankId: payload.tankId,
        volumeL: payload.volumeL,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      })
      await db.tanks.update(payload.tankId, { state: '在用', updatedAt: now } as never)
      await bumpVersion()
    })
    currentBatchId.value = id
    return id
  }

  /** 改绑罐位：仅支持单罐批次（倒罐拆罐后请用倒罐调整）；校验新罐可用后在事务内搬迁分罐 */
  async function updateBatch(id: string, patch: Partial<Batch>, current: BatchRow): Promise<void> {
    error.value = null
    if (patch.tankId && patch.tankId !== current.tankId) {
      await assertTankAssignable(patch.tankId, id)
      await db.transaction('rw', [db.batches, db.tanks, db.tankAllocations, db.meta], async () => {
        const allocs = await db.tankAllocations.where('batchId').equals(id).toArray()
        if (allocs.length > 1) {
          throw new Error('该批次已拆分到多个罐，请通过倒罐调整罐位，不能直接改绑')
        }
        // 事务内最终复核：新罐不能已有其它批次分酒
        const occupants = (await db.tankAllocations.where('tankId').equals(patch.tankId as string).toArray())
          .filter((alloc) => alloc.batchId !== id)
        if (occupants.length > 0) throw new Error('目标罐已被其它批次占用，请刷新后重选')
        const now = Date.now()
        const only = allocs[0]
        if (only) {
          await db.tankAllocations.update(only.id, { tankId: patch.tankId, updatedAt: now } as never)
        }
        await updateBatchRow(id, { tankId: patch.tankId })
        await reconcileTankStates()
        await bumpVersion()
      })
      return
    }
    await updateBatchRow(id, patch)
  }

  /** 事务内推进占用版本号 */
  async function bumpVersion(): Promise<void> {
    const current = (await db.meta.get(RACK_VERSION_KEY))?.value ?? 0
    await db.meta.put({ key: RACK_VERSION_KEY, value: current + 1 })
  }

  async function deleteBatch(id: string): Promise<void> {
    await removeBatch(id)
    if (currentBatchId.value === id) currentBatchId.value = null
  }

  /** 出罐：释放罐位并归档批次 */
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
    deleteBatch,
    ship
  }
})
