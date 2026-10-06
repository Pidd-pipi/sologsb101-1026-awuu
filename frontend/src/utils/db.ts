/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db，结构版本 version(2)：
 *   v1：地块 / 发酵罐 / 入罐批次 / 发酵读数 / 作业 / 苹乳 / 品评 七张表
 *   v2：新增分罐占用 tankAllocations 与倒罐流水 rackings；倒罐真正搬酒，一个批次可拆进多个罐
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Batch } from '../types/batch'
import type { Reading } from '../types/reading'
import type { Operation } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import type { TankAllocation } from '../types/allocation'
import type { Racking } from '../types/racking'
import { nowIso } from './uuid'
import { planRacking } from './rackingPlan'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbwinetank-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号，便于后续按行迁移 */
export const ROW_REVISION = 1

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

export type ParcelRow = Parcel & Revisioned
export type TankRow = Tank & Revisioned
export type BatchRow = Batch & Revisioned
export type ReadingRow = Reading & Revisioned
export type OperationRow = Operation & Revisioned
export type MlfRow = Mlf & Revisioned
export type TastingRow = Tasting & Revisioned
export type TankAllocationRow = TankAllocation & Revisioned
export type RackingRow = Racking & Revisioned

class GbWineTankDatabase extends Dexie {
  parcels!: Table<ParcelRow, string>
  tanks!: Table<TankRow, string>
  batches!: Table<BatchRow, string>
  readings!: Table<ReadingRow, string>
  operations!: Table<OperationRow, string>
  mlfs!: Table<MlfRow, string>
  tastings!: Table<TastingRow, string>
  tankAllocations!: Table<TankAllocationRow, string>
  rackings!: Table<RackingRow, string>
  /** 单行元数据表：存放占用版本号等并发控制信息 */
  meta!: Table<{ key: string; value: number }, string>

  constructor() {
    super(DB_NAME)

    this.version(1)
      .stores({
        parcels: 'id, name, variety, aspect, updatedAt',
        tanks: 'id, code, material, tempControl, state, updatedAt',
        batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
        readings: 'id, batchId, date, updatedAt',
        operations: 'id, batchId, type, state, date, seq, updatedAt',
        mlfs: 'id, batchId, state, updatedAt',
        tastings: 'id, batchId, date, verdict, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['parcels', 'tanks', 'batches', 'readings', 'operations', 'mlfs', 'tastings']
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }
      })

    // v2：倒罐真正搬酒 —— 分罐占用表 + 倒罐流水表 + 元数据（占用版本号）
    this.version(2)
      .stores({
        parcels: 'id, name, variety, aspect, updatedAt',
        tanks: 'id, code, material, tempControl, state, updatedAt',
        batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
        readings: 'id, batchId, date, updatedAt',
        operations: 'id, batchId, type, state, date, seq, updatedAt',
        mlfs: 'id, batchId, state, updatedAt',
        tastings: 'id, batchId, date, verdict, updatedAt',
        tankAllocations: 'id, batchId, tankId, updatedAt',
        rackings: 'id, batchId, operationId, date, updatedAt',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        // v1 → v2：为每个在罐批次按「批次绑定罐 + 入罐量」补一条分罐占用
        const now = Date.now()
        const allocations: TankAllocationRow[] = []
        await tx
          .table('batches')
          .toCollection()
          .each((batch: BatchRow) => {
            if (batch.state !== '已出罐' && batch.tankId) {
              allocations.push({
                id: `alloc-${batch.id}`,
                batchId: batch.id,
                tankId: batch.tankId,
                volumeL: batch.volumeL,
                revision: ROW_REVISION,
                createdAt: now,
                updatedAt: now
              })
            }
          })
        await tx.table('tankAllocations').bulkPut(allocations)
      })
  }
}

export const db = new GbWineTankDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.parcels.count()) === 0) {
    await seedDatabase()
  }
  // 历史库可能没有分罐数据（异常升级路径）：做一次幂等补齐
  await backfillAllocations()
}

/** 分罐表为空但存在在罐批次时，按批次当前绑定罐回填（幂等） */
async function backfillAllocations(): Promise<void> {
  const count = await db.tankAllocations.count()
  if (count > 0) return
  const activeBatches = await db.batches.filter((b) => b.state !== '已出罐' && !!b.tankId).toArray()
  if (activeBatches.length === 0) return
  const now = Date.now()
  await db.tankAllocations.bulkPut(
    activeBatches.map((batch) => ({
      id: `alloc-${batch.id}`,
      batchId: batch.id,
      tankId: batch.tankId as string,
      volumeL: batch.volumeL,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    }))
  )
}

/* ------------------------- 分罐占用（罐位事实表） ------------------------- */

/** 罐位占用版本号 key：任何占用变更都会 +1，提交倒罐时做乐观并发校验 */
export const RACK_VERSION_KEY = 'rackVersion'

export async function listAllocations(): Promise<TankAllocationRow[]> {
  return db.tankAllocations.toArray()
}

export async function listRackings(): Promise<RackingRow[]> {
  const rows = await db.rackings.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
}

/** 读取当前占用版本号（不存在视为 0） */
export async function getRackVersion(): Promise<number> {
  const row = await db.meta.get(RACK_VERSION_KEY)
  return row?.value ?? 0
}

/**
 * 计算某罐当前已占用容量（全部在罐批次在该罐的分酒量之和）。
 * 可传入已加载的占用行避免重复查表。
 */
export function occupiedVolumeOfTank(tankId: string, allocations: TankAllocationRow[]): number {
  return allocations
    .filter((item) => item.tankId === tankId)
    .reduce((sum, item) => sum + item.volumeL, 0)
}

/** 该批次在全部罐中的在罐总量（分酒量之和） */
export function batchVolumeInTanks(batchId: string, allocations: TankAllocationRow[]): number {
  return allocations
    .filter((item) => item.batchId === batchId)
    .reduce((sum, item) => sum + item.volumeL, 0)
}

/** 该批次在指定罐内的酒量（无分罐行返回 0） */
export function batchVolumeInTank(
  batchId: string,
  tankId: string,
  allocations: TankAllocationRow[]
): number {
  return allocations
    .filter((item) => item.batchId === batchId && item.tankId === tankId)
    .reduce((sum, item) => sum + item.volumeL, 0)
}

/* ------------------------------ 地块 ------------------------------ */

export async function listParcels(): Promise<ParcelRow[]> {
  const rows = await db.parcels.toArray()
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putParcel(row: ParcelRow): Promise<void> {
  await db.parcels.put(row)
}

export async function updateParcel(id: string, patch: Partial<Parcel>): Promise<void> {
  await db.parcels.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 删除地块：级联删除其下批次及批次的读数/作业/苹乳/品评/分罐/倒罐流水，并释放占用的罐位 */
export async function removeParcel(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.parcels,
      db.batches,
      db.readings,
      db.operations,
      db.mlfs,
      db.tastings,
      db.tanks,
      db.tankAllocations,
      db.rackings,
      db.meta
    ],
    async () => {
      const batches = await db.batches.where('parcelId').equals(id).toArray()
      for (const batch of batches) {
        await cascadeRemoveBatch(batch.id)
      }
      await db.parcels.delete(id)
      await bumpRackVersion()
      await reconcileTankStates()
    }
  )
}

/* ------------------------------ 发酵罐 ------------------------------ */

export async function listTanks(): Promise<TankRow[]> {
  const rows = await db.tanks.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putTank(row: TankRow): Promise<void> {
  await db.tanks.put(row)
}

export async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
  await db.tanks.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeTank(id: string): Promise<void> {
  const active = await db.batches.where('tankId').equals(id).filter((b) => b.state !== '已出罐').count()
  if (active > 0) {
    throw new Error('该罐仍有在罐批次，请先出罐或改绑其它罐位')
  }
  const occupied = await db.tankAllocations.where('tankId').equals(id).count()
  if (occupied > 0) {
    throw new Error('该罐仍有分罐酒量，请先出罐或倒罐清空')
  }
  await db.transaction('rw', db.tanks, db.batches, async () => {
    await db.batches.where('tankId').equals(id).modify({ tankId: '', updatedAt: Date.now() })
    await db.tanks.delete(id)
  })
}

/* ------------------------------ 入罐批次 ------------------------------ */

export async function listBatches(): Promise<BatchRow[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.harvestDate.localeCompare(a.harvestDate))
}

export async function putBatch(row: BatchRow): Promise<void> {
  await db.batches.put(row)
}

export async function updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
  await db.batches.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 内部级联删除：清掉批次下属全部子表数据与分罐占用 */
async function cascadeRemoveBatch(batchId: string): Promise<void> {
  await db.readings.where('batchId').equals(batchId).delete()
  await db.operations.where('batchId').equals(batchId).delete()
  await db.mlfs.where('batchId').equals(batchId).delete()
  await db.tastings.where('batchId').equals(batchId).delete()
  await db.rackings.where('batchId').equals(batchId).delete()
  await db.tankAllocations.where('batchId').equals(batchId).delete()
  const batch = await db.batches.get(batchId)
  if (batch && batch.tankId) {
    await db.tanks.update(batch.tankId, { state: '空闲', updatedAt: Date.now() } as never)
  }
  await db.batches.delete(batchId)
}

export async function removeBatch(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.batches,
      db.readings,
      db.operations,
      db.mlfs,
      db.tastings,
      db.tanks,
      db.tankAllocations,
      db.rackings,
      db.meta
    ],
    async () => {
      await cascadeRemoveBatch(id)
      await bumpRackVersion()
      await reconcileTankStates()
    }
  )
}

/** 出罐：批次置为已出罐，清掉分罐占用并自动释放罐位 */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.batches, db.tanks, db.tankAllocations, db.meta],
    async () => {
      const batch = await db.batches.get(id)
      if (!batch) throw new Error('批次不存在')
      await db.tankAllocations.where('batchId').equals(id).delete()
      if (batch.tankId) {
        await db.tanks.update(batch.tankId, { state: '空闲', updatedAt: Date.now() } as never)
      }
      await db.batches.update(id, { state: '已出罐', tankId: '', updatedAt: Date.now() } as never)
      await bumpRackVersion()
      await reconcileTankStates()
    }
  )
}

/** 校验罐位是否可以分配给指定批次（以分罐占用为准） */
export async function assertTankAssignable(tankId: string, batchId: string | null): Promise<void> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可分配`)
  const allocations = await db.tankAllocations.where('tankId').equals(tankId).toArray()
  const others = allocations.filter((item) => item.batchId !== batchId)
  if (others.length > 0) {
    throw new Error(`罐 ${tank.code} 已被批次占用，禁止重复分配`)
  }
}

/* ------------------------------ 发酵读数 ------------------------------ */

export async function listReadings(): Promise<ReadingRow[]> {
  const rows = await db.readings.toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReading(row: ReadingRow): Promise<void> {
  await db.readings.put(row)
}

export async function updateReading(id: string, patch: Partial<Reading>): Promise<void> {
  await db.readings.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeReading(id: string): Promise<void> {
  await db.readings.delete(id)
}

/* -------------------------------- 作业 -------------------------------- */

export async function listOperations(): Promise<OperationRow[]> {
  const rows = await db.operations.toArray()
  return rows.sort((a, b) => a.seq - b.seq || a.date.localeCompare(b.date))
}

export async function putOperation(row: OperationRow): Promise<void> {
  await db.operations.put(row)
}

export async function updateOperation(id: string, patch: Partial<Operation>): Promise<void> {
  await db.operations.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeOperation(id: string): Promise<void> {
  await db.operations.delete(id)
}

/** 批量写回拖拽后的作业顺序 */
export async function reorderOperations(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.operations, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.operations.update(orderedIds[index], { seq: index + 1, updatedAt: Date.now() } as never)
    }
  })
}

/** 作业完成：置为已完成并回写批次的最近作业时间 */
export async function completeOperation(id: string): Promise<void> {
  await db.transaction('rw', db.operations, db.batches, async () => {
    const operation = await db.operations.get(id)
    if (!operation) throw new Error('作业不存在')
    await db.operations.update(id, { state: '已完成', updatedAt: Date.now() } as never)
    await db.batches.update(operation.batchId, { lastOperationAt: nowIso(), updatedAt: Date.now() } as never)
  })
}

/** 某个批次现有作业的最大序号 */
export async function nextOperationSeq(batchId: string): Promise<number> {
  const rows = await db.operations.where('batchId').equals(batchId).toArray()
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1
}

/* --------------------------- 倒罐（真正搬酒） --------------------------- */

/** 倒罐提交入参 */
export interface RackingInput {
  batchId: string
  /** 倒出罐（必须是该批次当前占酒的罐） */
  fromTankId: string
  /** 目标罐（按表单顺序逐个装） */
  targetTankIds: string[]
  /** 计划倒出量 L */
  plannedVolumeL: number
  date: string
  durationMin: number
  operator: string
  /** 打开表单时读到的占用版本号，提交时做乐观并发校验 */
  expectedRackVersion: number
}

/** 倒罐提交结果（供页面提示） */
export interface RackingResult {
  operationId: string
  rackingId: string
  plannedVolumeL: number
  movedVolumeL: number
  remainingVolumeL: number
  splits: Array<{ tankId: string; tankCode: string; volumeL: number }>
  /** 目标罐总空余不足，实际只搬走部分 */
  partial: boolean
}

/** 占用版本号 +1（必须在事务内调用） */
async function bumpRackVersion(): Promise<void> {
  const current = (await db.meta.get(RACK_VERSION_KEY))?.value ?? 0
  await db.meta.put({ key: RACK_VERSION_KEY, value: current + 1 })
}

/**
 * 按分罐占用重算全部罐位状态：
 * - 有任何在罐分酒量 → 在用
 * - 清洗中保持清洗中（清洗是人工流程，不被占用自动覆盖）
 * - 无占酒 → 空闲
 * 必须在事务内调用。
 */
export async function reconcileTankStates(): Promise<void> {
  const [tanks, allocations] = await Promise.all([db.tanks.toArray(), db.tankAllocations.toArray()])
  const now = Date.now()
  for (const tank of tanks) {
    const occupied = occupiedVolumeOfTank(tank.id, allocations) > 0
    const next = occupied ? '在用' : tank.state === '清洗中' ? '清洗中' : '空闲'
    if (next !== tank.state) {
      await db.tanks.update(tank.id, { state: next, updatedAt: now } as never)
    }
  }
}

/**
 * 倒罐：按目标罐容量依次装酒，一个批次可拆进几个罐；目标罐装不下就分批倒，余量留在原罐。
 * 作业、倒罐流水、分罐占用、罐位状态在同一个 Dexie 事务内写入，任一失败整批回滚。
 * 并发：先比对占用版本号，再复核每个目标罐的实时空余容量；别人先提交占用变化时本事务中止。
 */
export async function submitRacking(input: RackingInput): Promise<RackingResult> {
  if (!input.batchId) throw new Error('请选择批次')
  if (!input.fromTankId) throw new Error('请选择倒出罐')
  if (input.targetTankIds.length === 0) throw new Error('请至少选择一个目标罐')
  if (input.targetTankIds.includes(input.fromTankId)) throw new Error('目标罐不能与倒出罐相同')
  if (!(input.plannedVolumeL > 0)) throw new Error('倒罐量必须大于 0')
  if (new Set(input.targetTankIds).size !== input.targetTankIds.length) throw new Error('目标罐重复，请重新选择')

  return db.transaction(
    'rw',
    [db.batches, db.tanks, db.operations, db.tankAllocations, db.rackings, db.meta],
    async () => {
      // 1) 乐观并发：占用版本号变化说明打开页面后有人动过罐位
      const version = (await db.meta.get(RACK_VERSION_KEY))?.value ?? 0
      if (version !== input.expectedRackVersion) {
        throw new Error('罐位占用已发生变化（可能有其他人先提交了倒罐），请刷新罐位后重试')
      }

      const [batch, tanks, allocations] = await Promise.all([
        db.batches.get(input.batchId),
        db.tanks.toArray(),
        db.tankAllocations.toArray()
      ])
      if (!batch) throw new Error('批次不存在')
      if (batch.state === '已出罐') throw new Error('批次已出罐，不能再倒罐')

      // 2) 倒出罐中必须确实有该批次的酒
      const sourceVolume = batchVolumeInTank(input.batchId, input.fromTankId, allocations)
      if (sourceVolume <= 0) {
        const sourceTank = tanks.find((t) => t.id === input.fromTankId)
        throw new Error(`倒出罐 ${sourceTank?.code ?? ''} 中没有该批次的酒，请刷新后重选`)
      }
      // 3) 目标罐逐一复核：存在、非清洗、空余容量按实时占用重算（事务内最终防线）
      const targetCapacities = input.targetTankIds.map((tankId) => {
        const tank = tanks.find((item) => item.id === tankId)
        if (!tank) throw new Error('目标罐不存在')
        if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，不能作为目标罐`)
        // 同批次已在该罐有酒时，空余容量按剩余空间算（允许往自己已占的罐里继续倒）
        const ownVolume = batchVolumeInTank(input.batchId, tankId, allocations)
        const usedByOthers = occupiedVolumeOfTank(tankId, allocations) - ownVolume
        if (usedByOthers > 0.0001) {
          throw new Error(`罐 ${tank.code} 已被其它批次占用`)
        }
        return { tankId, tankCode: tank.code, freeL: round1(tank.capacityL - usedByOthers - ownVolume) }
      })

      // 4) 贪心装酒：按表单顺序逐罐装，容量不够轮到下一个罐，余下留在原罐
      const plan = planRacking({
        sourceBatchVolumeL: sourceVolume,
        plannedL: input.plannedVolumeL,
        targets: targetCapacities.filter((target) => target.freeL > 0)
      })
      const movedVolumeL = plan.movedL
      const splits = new Map<string, number>(plan.splits.map((split) => [split.tankId, split.putL]))
      if (movedVolumeL <= 0) {
        throw new Error('目标罐没有可容纳的空余容量，本次倒罐未执行')
      }

      // 5) 写分罐占用：从倒出罐扣减，向目标罐增加（同罐已有分酒行则累加）
      const now = Date.now()
      const sourceRow = allocations.find(
        (item) => item.batchId === input.batchId && item.tankId === input.fromTankId
      )
      const sourceLeft = round1(sourceVolume - movedVolumeL)
      if (sourceRow) {
        if (sourceLeft <= 0) {
          await db.tankAllocations.delete(sourceRow.id)
        } else {
          await db.tankAllocations.update(sourceRow.id, { volumeL: sourceLeft, updatedAt: now } as never)
        }
      }

      for (const [tankId, volumeL] of splits) {
        const existing = allocations.find(
          (item) => item.batchId === input.batchId && item.tankId === tankId
        )
        if (existing) {
          await db.tankAllocations.update(existing.id, {
            volumeL: round1(existing.volumeL + volumeL),
            updatedAt: now
          } as never)
        } else {
          await db.tankAllocations.add({
            id: `alloc-${input.batchId}-${tankId}-${now.toString(36)}`,
            batchId: input.batchId,
            tankId,
            volumeL,
            revision: ROW_REVISION,
            createdAt: now,
            updatedAt: now
          })
        }
      }

      // 6) 写作业（倒罐）与倒罐流水 —— 与分罐、罐位同事务，失败一起回滚
      const seq = (await db.operations.where('batchId').equals(input.batchId).toArray()).reduce(
        (max, row) => Math.max(max, row.seq),
        0
      ) + 1
      const operationId = `operation-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      await db.operations.add({
        id: operationId,
        batchId: input.batchId,
        type: '倒罐',
        date: input.date,
        durationMin: input.durationMin,
        operator: input.operator,
        state: '已完成',
        seq,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      })

      const remainingVolumeL = round1(sourceVolume - movedVolumeL)
      const rackingId = `racking-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      await db.rackings.add({
        id: rackingId,
        operationId,
        batchId: input.batchId,
        fromTankId: input.fromTankId,
        plannedVolumeL: input.plannedVolumeL,
        movedVolumeL,
        remainingVolumeL,
        splits: Array.from(splits, ([tankId, volumeL]) => ({ tankId, volumeL })),
        date: input.date,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      })

      // 7) 批次主罐指向：留在原罐有酒则仍是原罐；否则指向第一个目标罐；在罐量同步为分酒量之和
      const afterAllocations = await db.tankAllocations.where('batchId').equals(input.batchId).toArray()
      const totalInTanks = round1(afterAllocations.reduce((sum, item) => sum + item.volumeL, 0))
      const primaryTankId =
        sourceLeft > 0 ? input.fromTankId : splits.size > 0 ? splits.keys().next().value ?? '' : ''
      await db.batches.update(input.batchId, {
        tankId: primaryTankId,
        volumeL: totalInTanks,
        lastOperationAt: nowIso(),
        updatedAt: now
      } as never)

      // 8) 罐位状态立即重算，并推进占用版本号
      await reconcileTankStates()
      await bumpRackVersion()

      return {
        operationId,
        rackingId,
        plannedVolumeL: input.plannedVolumeL,
        movedVolumeL,
        remainingVolumeL,
        partial: movedVolumeL < input.plannedVolumeL,
        splits: Array.from(splits, ([tankId, volumeL]) => ({
          tankId,
          tankCode: tanks.find((t) => t.id === tankId)?.code ?? tankId,
          volumeL
        }))
      }
    }
  )
}

/** 容量保留 1 位小数，避免浮点尾差 */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/* ------------------------------ 苹乳发酵 ------------------------------ */

export async function listMlfs(): Promise<MlfRow[]> {
  return db.mlfs.toArray()
}

export async function putMlf(row: MlfRow): Promise<void> {
  await db.mlfs.put(row)
}

export async function updateMlf(id: string, patch: Partial<Mlf>): Promise<void> {
  await db.mlfs.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeMlf(id: string): Promise<void> {
  await db.mlfs.delete(id)
}

/* ------------------------------ 品评调配 ------------------------------ */

export async function listTastings(): Promise<TastingRow[]> {
  const rows = await db.tastings.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putTasting(row: TastingRow): Promise<void> {
  await db.tastings.put(row)
}

export async function updateTasting(id: string, patch: Partial<Tasting>): Promise<void> {
  await db.tastings.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeTasting(id: string): Promise<void> {
  await db.tastings.delete(id)
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  parcels: Parcel[]
  tanks: Tank[]
  batches: Batch[]
  readings: Reading[]
  operations: Operation[]
  mlfs: Mlf[]
  tastings: Tasting[]
  tankAllocations: TankAllocation[]
  rackings: Racking[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, tankAllocations, rackings] =
    await Promise.all([
      db.parcels.toArray(),
      db.tanks.toArray(),
      db.batches.toArray(),
      db.readings.toArray(),
      db.operations.toArray(),
      db.mlfs.toArray(),
      db.tastings.toArray(),
      db.tankAllocations.toArray(),
      db.rackings.toArray()
    ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    parcels: parcels.map(stripRow),
    tanks: tanks.map(stripRow),
    batches: batches.map(stripRow),
    readings: readings.map(stripRow),
    operations: operations.map(stripRow),
    mlfs: mlfs.map(stripRow),
    tastings: tastings.map(stripRow),
    tankAllocations: tankAllocations.map(stripRow),
    rackings: rackings.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.parcels,
      db.tanks,
      db.batches,
      db.readings,
      db.operations,
      db.mlfs,
      db.tastings,
      db.tankAllocations,
      db.rackings,
      db.meta
    ],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.tankAllocations.clear(),
        db.rackings.clear()
      ])
      await db.parcels.bulkPut(snapshot.parcels.map(stamp))
      await db.tanks.bulkPut(snapshot.tanks.map(stamp))
      await db.batches.bulkPut(snapshot.batches.map(stamp))
      await db.readings.bulkPut(snapshot.readings.map(stamp))
      await db.operations.bulkPut(snapshot.operations.map(stamp))
      await db.mlfs.bulkPut(snapshot.mlfs.map(stamp))
      await db.tastings.bulkPut(snapshot.tastings.map(stamp))
      // 兼容旧备份：没有分罐数据时按批次绑定罐回填
      const allocations =
        Array.isArray(snapshot.tankAllocations) && snapshot.tankAllocations.length > 0
          ? snapshot.tankAllocations
          : snapshot.batches
              .filter((b) => b.state !== '已出罐' && !!b.tankId)
              .map((b) => ({ id: `alloc-${b.id}`, batchId: b.id, tankId: b.tankId as string, volumeL: b.volumeL }))
      await db.tankAllocations.bulkPut(allocations.map(stamp))
      if (Array.isArray(snapshot.rackings)) {
        await db.rackings.bulkPut(snapshot.rackings.map(stamp))
      }
      await db.meta.put({ key: RACK_VERSION_KEY, value: 0 })
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.parcels,
      db.tanks,
      db.batches,
      db.readings,
      db.operations,
      db.mlfs,
      db.tastings,
      db.tankAllocations,
      db.rackings,
      db.meta
    ],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.tankAllocations.clear(),
        db.rackings.clear()
      ])
      await db.meta.put({ key: RACK_VERSION_KEY, value: 0 })
    }
  )
  await seedDatabase()
}

/** 各表行数统计，供页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, tankAllocations, rackings] =
    await Promise.all([
      db.parcels.count(),
      db.tanks.count(),
      db.batches.count(),
      db.readings.count(),
      db.operations.count(),
      db.mlfs.count(),
      db.tastings.count(),
      db.tankAllocations.count(),
      db.rackings.count()
    ])
  return { parcels, tanks, batches, readings, operations, mlfs, tastings, tankAllocations, rackings }
}
