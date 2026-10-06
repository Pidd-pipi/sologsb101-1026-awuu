/**
 * 倒罐容量规划（纯函数）：页面预览与数据库事务共用同一份算法，保证所见即所得。
 * 规则：按目标罐给定顺序逐个装，容量不够轮到下一个罐，余下留在原罐。
 */

export interface RackingTargetCapacity {
  tankId: string
  tankCode: string
  /** 该罐当前可用空余容量（L，已扣除全部在罐占用；本批次自己的占用也算占用） */
  freeL: number
}

export interface RackingPlannedSplit extends RackingTargetCapacity {
  /** 本次计划倒入该罐的量（L） */
  putL: number
}

export interface RackingPlan {
  /** 实际尝试搬酒量 = min(计划量, 倒出罐内本批次酒量) */
  wantedL: number
  /** 目标罐总共装下的量 */
  movedL: number
  /** 留在原罐的量 */
  remainingL: number
  splits: RackingPlannedSplit[]
  /** 目标罐总空余不足，只搬走了一部分 */
  partial: boolean
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export function planRacking(params: {
  /** 倒出罐中该批次当前的酒量 */
  sourceBatchVolumeL: number
  /** 表单计划倒出量 */
  plannedL: number
  targets: RackingTargetCapacity[]
}): RackingPlan {
  const wantedL = round1(Math.min(params.plannedL, params.sourceBatchVolumeL))
  let remaining = wantedL
  const splits: RackingPlannedSplit[] = []
  for (const target of params.targets) {
    if (remaining <= 0) break
    const putL = round1(Math.min(target.freeL, remaining))
    if (putL > 0) {
      splits.push({ ...target, putL })
      remaining = round1(remaining - putL)
    }
  }
  const movedL = round1(wantedL - remaining)
  return {
    wantedL,
    movedL,
    remainingL: round1(params.sourceBatchVolumeL - movedL),
    splits,
    partial: movedL < wantedL
  }
}
