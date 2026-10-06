/**
 * 倒罐分罐纯算法：按目标罐容量把源罐的酒依次灌满，余下留在原罐。
 * 不触碰数据库，便于在 UI 上实时预览计划。
 */
import type { PlanTargetInput, PlannedTarget, RackPlan } from '@/types/split'

export interface PlanRackingInput {
  sourceTankId: string
  /** 源罐当前酒量 L */
  sourceVolumeL: number
  targets: PlanTargetInput[]
}

/**
 * 计算分罐计划：
 * - 一个批次可以拆进几个罐，按目标列表顺序逐个倒
 * - 目标罐按其剩余容量（容量 − 本批次已在该罐的量）接收，倒满即换下一个
 * - 目标罐总容量不够就分批倒（每个罐只接收到自己的剩余容量），余下的留在原罐
 * 浮点折算到整数毫升（round），避免拆分多罐后总量对不上。
 */
export function planRacking(input: PlanRackingInput): RackPlan {
  const sourceTankId = input.sourceTankId
  const sourceVolumeL = Math.max(0, Math.round(input.sourceVolumeL))
  let remaining = sourceVolumeL

  const targets: PlannedTarget[] = []
  for (const raw of input.targets) {
    if (remaining <= 0) break
    const selfVolumeL = Math.max(0, Math.round(raw.selfVolumeL ?? 0))
    const freeL = Math.max(0, Math.round(raw.capacityL) - selfVolumeL)
    if (raw.tankId === sourceTankId || freeL <= 0) continue
    const moveVolumeL = Math.min(remaining, freeL)
    remaining -= moveVolumeL
    targets.push({
      tankId: raw.tankId,
      capacityL: Math.round(raw.capacityL),
      selfVolumeL,
      moveVolumeL,
      afterVolumeL: selfVolumeL + moveVolumeL
    })
  }

  const movedTotalL = targets.reduce((sum, target) => sum + target.moveVolumeL, 0)
  return {
    sourceTankId,
    sourceVolumeL,
    targets,
    movedTotalL,
    leftVolumeL: sourceVolumeL - movedTotalL
  }
}
