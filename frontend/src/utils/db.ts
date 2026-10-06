/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 地块 / 发酵罐 / 入罐批次 / 发酵读数 / 作业 / 苹乳 / 品评 / 分罐 八张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Batch } from '../types/batch'
import type { Reading } from '../types/reading'
import type { Operation, RackDetail } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import type { RackRequest, RackPlan, Split } from '../types/split'
import { splitId } from '../types/split'
import { planRacking } from './racking'
import { createId, nowIso } from './uuid'
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
export type SplitRow = Split & Revisioned

/**
 * 倒罐并发/罐位冲突：两个人同时提交同一批次倒罐时，
 * 后到的一次在事务内看到目标罐位已被占用，抛出本错误让页面停下并提示。
 */
export class RackConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RackConflictError'
  }
}

class GbWineTankDatabase extends Dexie {
  parcels!: Table<ParcelRow, string>
  tanks!: Table<TankRow, string>
  batches!: Table<BatchRow, string>
  readings!: Table<ReadingRow, string>
  operations!: Table<OperationRow, string>
  mlfs!: Table<MlfRow, string>
  tastings!: Table<TastingRow, string>
  splits!: Table<SplitRow, string>

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

    // v2：新增分罐表。历史在罐批次按 batch.tankId + batch.volumeL 回填一条分罐，
    // 使老库升级后罐位占用与在罐量立即与新口径一致。
    this.version(2)
      .stores({
        splits: 'id, batchId, tankId, updatedAt'
      })
      .upgrade(async (tx) => {
        const batches = await tx.table<BatchRow, string>('batches').toArray()
        const splitsTable = tx.table<SplitRow, string>('splits')
        const now = Date.now()
        for (const batch of batches) {
          if (batch.state === '已出罐' || !batch.tankId) continue
          await splitsTable.put({
            id: splitId(batch.id, batch.tankId),
            batchId: batch.id,
            tankId: batch.tankId,
            volumeL: batch.volumeL,
            lastOperationId: null,
            rackedAt: null,
            revision: ROW_REVISION,
            createdAt: batch.createdAt ?? now,
            updatedAt: now
          })
        }
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

/** 删除地块：级联删除其下批次及批次的读数/作业/苹乳/品评，并释放占用的罐位 */
export async function removeParcel(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks, db.splits],
    async () => {
      const batches = await db.batches.where('parcelId').equals(id).toArray()
      for (const batch of batches) {
        await cascadeRemoveBatch(batch.id)
      }
      await db.parcels.delete(id)
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
  const active = await db.splits.where('tankId').equals(id).filter((split) => split.volumeL > 0).count()
  if (active > 0) {
    throw new Error('该罐仍有在罐酒量，请先出罐或倒罐改绑其它罐位')
  }
  await db.transaction('rw', db.tanks, db.batches, db.splits, async () => {
    await db.splits.where('tankId').equals(id).delete()
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

/** 释放一批罐位：仅当罐里已无任何在罐分罐时才置回「空闲」 */
async function releaseTankIfEmpty(tankId: string, timestamp: number): Promise<void> {
  const stillOccupied = await db.splits
    .where('tankId')
    .equals(tankId)
    .filter((split) => split.volumeL > 0)
    .count()
  if (stillOccupied === 0) {
    await db.tanks.update(tankId, { state: '空闲', updatedAt: timestamp } as never)
  }
}

/** 内部级联删除：清掉批次下属全部子表数据并释放全部占用罐位 */
async function cascadeRemoveBatch(batchId: string): Promise<void> {
  await db.readings.where('batchId').equals(batchId).delete()
  await db.operations.where('batchId').equals(batchId).delete()
  await db.mlfs.where('batchId').equals(batchId).delete()
  await db.tastings.where('batchId').equals(batchId).delete()
  const occupiedTanks = (await db.splits.where('batchId').equals(batchId).toArray()).map((split) => split.tankId)
  await db.splits.where('batchId').equals(batchId).delete()
  const now = Date.now()
  for (const tankId of occupiedTanks) {
    await releaseTankIfEmpty(tankId, now)
  }
  await db.batches.delete(batchId)
}

export async function removeBatch(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks, db.splits],
    async () => {
      await cascadeRemoveBatch(id)
    }
  )
}

/** 出罐：批次置为已出罐、清空全部分罐并自动释放所有占用罐位 */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction('rw', db.batches, db.tanks, db.splits, async () => {
    const batch = await db.batches.get(id)
    if (!batch) throw new Error('批次不存在')
    const occupiedTanks = (await db.splits.where('batchId').equals(id).toArray()).map((split) => split.tankId)
    await db.splits.where('batchId').equals(id).delete()
    const now = Date.now()
    for (const tankId of occupiedTanks) {
      await releaseTankIfEmpty(tankId, now)
    }
    await db.batches.update(id, { state: '已出罐', updatedAt: now } as never)
  })
}

/** 校验罐位是否可以分配给指定批次（以分罐表为占用事实） */
export async function assertTankAssignable(tankId: string, batchId: string | null): Promise<void> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可分配`)
  const occupant = await db.splits
    .where('tankId')
    .equals(tankId)
    .filter((split) => split.volumeL > 0 && split.batchId !== batchId)
    .first()
  if (occupant) {
    throw new Error(`罐 ${tank.code} 已被批次占用，禁止重复分配`)
  }
}

/**
 * 入罐登记（原子）：校验罐位可分配且容量装得下入罐量，
 * 一次事务写入批次、首条分罐、罐位「在用」；失败整体回滚。
 * 容量不够时提示先入大罐、再用倒罐拆进多个罐。
 */
export async function intakeBatch(payload: Omit<Batch, 'id' | 'lastOperationAt'>): Promise<string> {
  return db.transaction('rw', db.batches, db.tanks, db.splits, async () => {
    const tank = await db.tanks.get(payload.tankId)
    if (!tank) throw new Error('发酵罐不存在')
    if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可分配`)
    const occupant = await db.splits
      .where('tankId')
      .equals(payload.tankId)
      .filter((split) => split.volumeL > 0)
      .first()
    if (occupant) throw new Error(`罐 ${tank.code} 已被批次占用，禁止重复分配`)
    if (payload.volumeL > tank.capacityL) {
      throw new Error(
        `入罐量 ${payload.volumeL}L 超过罐 ${tank.code} 的容量 ${tank.capacityL}L：请先入罐到更大的罐，再用倒罐拆进多个罐`
      )
    }
    const now = Date.now()
    const id = createId('batch')
    await db.batches.put({ ...payload, id, lastOperationAt: null, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    await db.splits.put({
      id: splitId(id, payload.tankId),
      batchId: id,
      tankId: payload.tankId,
      volumeL: payload.volumeL,
      lastOperationId: null,
      rackedAt: null,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
    await db.tanks.update(payload.tankId, { state: '在用', updatedAt: now } as never)
    return id
  })
}

/**
 * 把一个在罐批次整批分配到指定罐（罐位看板「分配批次」）：
 * 单事务完成占用冲突校验、容量校验、分罐迁移与新旧罐位状态置位。
 */
export async function assignBatchToTank(tankId: string, batchId: string): Promise<void> {
  await db.transaction('rw', db.tanks, db.batches, db.splits, async () => {
    const tank = await db.tanks.get(tankId)
    if (!tank) throw new Error('发酵罐不存在')
    if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可分配`)
    const batch = await db.batches.get(batchId)
    if (!batch) throw new Error('批次不存在')
    if (batch.state === '已出罐') throw new Error('该批次已出罐，不能再分配罐位')
    const occupant = await db.splits
      .where('tankId')
      .equals(tankId)
      .filter((split) => split.volumeL > 0 && split.batchId !== batchId)
      .first()
    if (occupant) throw new Error(`罐 ${tank.code} 已被其它批次占用，禁止重复分配`)

    const current = await db.splits.where('batchId').equals(batchId).toArray()
    const totalVolumeL = current.reduce((sum, split) => sum + split.volumeL, 0)
    if (totalVolumeL > tank.capacityL) {
      throw new Error(`批次在罐量 ${totalVolumeL}L 超过罐 ${tank.code} 的容量 ${tank.capacityL}L，无法整批分配，请改用倒罐拆分`)
    }

    const now = Date.now()
    await db.splits.where('batchId').equals(batchId).delete()
    await db.splits.put({
      id: splitId(batchId, tankId),
      batchId,
      tankId,
      volumeL: totalVolumeL,
      lastOperationId: null,
      rackedAt: null,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
    for (const split of current) {
      if (split.tankId !== tankId) await releaseTankIfEmpty(split.tankId, now)
    }
    await db.tanks.update(tankId, { state: '在用', updatedAt: now } as never)
    await db.batches.update(batchId, { tankId, updatedAt: now } as never)
  })
}

/* ------------------------------ 倒罐 ------------------------------ */

export interface RackingResult {
  plan: RackPlan
  operationId: string
}

/**
 * 执行倒罐：按目标罐容量把酒搬出，一个批次可拆进几个罐，
 * 目标罐容量不够就分批倒，余下的留在原罐。
 *
 * 作业（operations）、分罐（splits）、罐位（tanks）在同一个 IndexedDB
 * 读写事务里提交，任一写入失败整批回滚，不留半截记录。
 *
 * 并发：IndexedDB 对 scope 重叠的读写事务保证串行执行，后到的事务一定能
 * 看到先到者已提交的占用；同时带批次 updatedAt 版本戳，两个人各开页面
 * 提交同一批次时，后到的一次会收到 RackConflictError 并停下来提示。
 */
export async function performRacking(request: RackRequest): Promise<RackingResult> {
  if (!request.operator.trim()) throw new Error('请填写操作人')
  if (!request.date) throw new Error('请选择作业日期')

  return db.transaction('rw', db.operations, db.batches, db.tanks, db.splits, async () => {
    const batch = await db.batches.get(request.batchId)
    if (!batch) throw new Error('批次不存在')
    if (batch.state === '已出罐') throw new Error('该批次已出罐，不能再倒罐')

    // 版本戳：另一个页面已先提交（任何写批次的动作都会刷新 updatedAt）
    if (
      typeof request.expectedBatchUpdatedAt === 'number' &&
      batch.updatedAt !== request.expectedBatchUpdatedAt
    ) {
      throw new RackConflictError('该批次刚被其他人改动（罐位可能已变化），请刷新页面核对最新罐位后重试')
    }

    const sourceSplit = await db.splits.get(splitId(request.batchId, request.sourceTankId))
    if (!sourceSplit || sourceSplit.volumeL <= 0) {
      throw new Error('源罐内当前没有该批次的酒，无法倒罐')
    }

    const targetIds = Array.from(new Set(request.targetTankIds)).filter(
      (tankId) => tankId && tankId !== request.sourceTankId
    )
    if (targetIds.length === 0) throw new Error('请至少选择一个目标罐')

    // 事务内重查每个目标罐的真实占用：后到的一次会在这里看到罐位已被占用
    const planTargets = []
    for (const tankId of targetIds) {
      const tank = await db.tanks.get(tankId)
      if (!tank) throw new Error(`目标罐不存在：${tankId}`)
      if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，不能作为倒罐目标`)
      const occupant = await db.splits
        .where('tankId')
        .equals(tankId)
        .filter((split) => split.volumeL > 0 && split.batchId !== request.batchId)
        .first()
      if (occupant) {
        throw new RackConflictError(
          `罐 ${tank.code} 的罐位已被其它批次占用，本次倒罐已停止；请刷新页面核对最新罐位后重试`
        )
      }
      const self = await db.splits.get(splitId(request.batchId, tankId))
      planTargets.push({ tankId, capacityL: tank.capacityL, selfVolumeL: self?.volumeL ?? 0 })
    }

    const plan = planRacking({
      sourceTankId: request.sourceTankId,
      sourceVolumeL: sourceSplit.volumeL,
      targets: planTargets
    })
    if (plan.targets.length === 0 || plan.movedTotalL <= 0) {
      throw new Error('所选目标罐没有可倒入的余量，请重新选择目标罐')
    }

    const now = Date.now()
    const existing = await db.operations.where('batchId').equals(request.batchId).toArray()
    const seq = existing.reduce((max, row) => Math.max(max, row.seq), 0) + 1
    const operationId = createId('operation')
    const rackDetail: RackDetail = {
      sourceTankId: plan.sourceTankId,
      targets: plan.targets.map((target) => ({ tankId: target.tankId, moveVolumeL: target.moveVolumeL })),
      leftVolumeL: plan.leftVolumeL
    }

    // 1) 作业
    await db.operations.put({
      id: operationId,
      batchId: request.batchId,
      type: '倒罐',
      date: request.date,
      durationMin: request.durationMin,
      operator: request.operator,
      state: '已完成',
      seq,
      rackDetail,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })

    // 2) 分罐：源罐减量（倒空则删除分罐行），目标罐逐罐 upsert
    if (plan.leftVolumeL > 0) {
      await db.splits.update(sourceSplit.id, {
        volumeL: plan.leftVolumeL,
        lastOperationId: operationId,
        rackedAt: nowIso(),
        updatedAt: now
      } as never)
    } else {
      await db.splits.delete(sourceSplit.id)
    }
    for (const target of plan.targets) {
      const targetSplitId = splitId(request.batchId, target.tankId)
      const previous = await db.splits.get(targetSplitId)
      await db.splits.put({
        id: targetSplitId,
        batchId: request.batchId,
        tankId: target.tankId,
        volumeL: target.afterVolumeL,
        lastOperationId: operationId,
        rackedAt: nowIso(),
        revision: ROW_REVISION,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      })
    }

    // 3) 罐位状态：目标罐置「在用」，源罐倒空置「空闲」
    for (const target of plan.targets) {
      await db.tanks.update(target.tankId, { state: '在用', updatedAt: now } as never)
    }
    if (plan.leftVolumeL === 0) {
      await releaseTankIfEmpty(plan.sourceTankId, now)
    }

    // 回写批次最近作业时间（同时刷新版本戳）
    await db.batches.update(request.batchId, { lastOperationAt: nowIso(), updatedAt: now } as never)

    return { plan, operationId }
  })
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
  splits: Split[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, splits] = await Promise.all([
    db.parcels.toArray(),
    db.tanks.toArray(),
    db.batches.toArray(),
    db.readings.toArray(),
    db.operations.toArray(),
    db.mlfs.toArray(),
    db.tastings.toArray(),
    db.splits.toArray()
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
    splits: splits.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.splits],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.splits.clear()
      ])
      await db.parcels.bulkPut(snapshot.parcels.map(stamp))
      await db.tanks.bulkPut(snapshot.tanks.map(stamp))
      await db.batches.bulkPut(snapshot.batches.map(stamp))
      await db.readings.bulkPut(snapshot.readings.map(stamp))
      await db.operations.bulkPut(snapshot.operations.map(stamp))
      await db.mlfs.bulkPut(snapshot.mlfs.map(stamp))
      await db.tastings.bulkPut(snapshot.tastings.map(stamp))
      // 兼容旧备份（无分罐表）：按在罐批次回填
      const splits =
        Array.isArray(snapshot.splits) && snapshot.splits.length > 0
          ? snapshot.splits
          : snapshot.batches
              .filter((batch) => batch.state !== '已出罐' && batch.tankId)
              .map((batch) => ({
                id: splitId(batch.id, batch.tankId),
                batchId: batch.id,
                tankId: batch.tankId,
                volumeL: batch.volumeL,
                lastOperationId: null,
                rackedAt: null
              }))
      await db.splits.bulkPut(splits.map(stamp))
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.splits],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.splits.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计，供页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, splits] = await Promise.all([
    db.parcels.count(),
    db.tanks.count(),
    db.batches.count(),
    db.readings.count(),
    db.operations.count(),
    db.mlfs.count(),
    db.tastings.count(),
    db.splits.count()
  ])
  return { parcels, tanks, batches, readings, operations, mlfs, tastings, splits }
}
