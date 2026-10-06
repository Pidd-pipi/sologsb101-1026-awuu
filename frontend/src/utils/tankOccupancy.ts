/**
 * 罐位占用与在罐量派生：以分罐表（splits）为唯一事实来源。
 * 倒罐、出罐后只要 splits 行更新，罐位占用与各处在罐量立刻按同一口径重算。
 * 泛型 <T extends Split>：纯领域计算接受 Split，页面可直接传入带修订号的 SplitRow。
 */
import type { Split } from '@/types/split'

/** 取某批次当前全部在罐分罐（可跨多个罐） */
export function splitsOfBatch<T extends Split>(splits: T[], batchId: string): T[] {
  return splits.filter((split) => split.batchId === batchId)
}

/** 当前占用某罐的分罐记录（一个罐同一时刻至多一个在罐批次） */
export function splitAtTank<T extends Split>(splits: T[], tankId: string): T | null {
  return splits.find((split) => split.tankId === tankId && split.volumeL > 0) ?? null
}

/** 当前占用某罐的在罐批次 id（无占用返回 null） */
export function occupantBatchIdAt<T extends Split>(splits: T[], tankId: string): string | null {
  return splitAtTank(splits, tankId)?.batchId ?? null
}

/** 某批次当前在罐总量（所有分罐量之和，L） */
export function batchInTankVolume<T extends Split>(splits: T[], batchId: string): number {
  return splitsOfBatch(splits, batchId).reduce((sum, split) => sum + split.volumeL, 0)
}

/** 某批次当前占用的罐 id 列表 */
export function batchTankIds<T extends Split>(splits: T[], batchId: string): string[] {
  return splitsOfBatch(splits, batchId)
    .filter((split) => split.volumeL > 0)
    .map((split) => split.tankId)
}

/** 某罐当前实际在罐量（L） */
export function tankOccupiedVolume<T extends Split>(splits: T[], tankId: string): number {
  return splitAtTank(splits, tankId)?.volumeL ?? 0
}

/** 按批次聚合在罐量：batchId -> 在罐量 L */
export function activeVolumesByBatch<T extends Split>(splits: T[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const split of splits) {
    if (split.volumeL <= 0) continue
    map.set(split.batchId, (map.get(split.batchId) ?? 0) + split.volumeL)
  }
  return map
}
