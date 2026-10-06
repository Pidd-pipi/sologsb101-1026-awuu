/**
 * 分罐：一个批次在某个发酵罐里当前存放的酒量（在罐量分罐事实）。
 * - 一个批次可拆进多个罐（同 batchId 多行）
 * - 一个罐同一时刻只允许一个在罐批次占用（同 tankId 至多一行）
 * - 入罐时写入首行；倒罐在单个事务内重建受影响罐的行；出罐/删除时清空
 */
export interface Split {
  /** 规则：`split:${batchId}:${tankId}`，upsert 幂等 */
  id: string
  /** 所属批次 */
  batchId: string
  /** 所在发酵罐 id */
  tankId: string
  /** 该罐内当前存放的酒量（L） */
  volumeL: number
  /** 最近一次改变该分罐的倒罐作业 id；入罐产生的首行为 null */
  lastOperationId: string | null
  /** 最近一次倒罐时间 ISO；入罐产生的首行为 null */
  rackedAt: string | null
}

/** 倒罐规划中的目标罐输入（纯计算用，不依赖数据库） */
export interface PlanTargetInput {
  tankId: string
  /** 目标罐容量 L */
  capacityL: number
  /** 本批次此前已在该罐的酒量 L（合罐场景；通常为 0） */
  selfVolumeL?: number
}

/** 倒罐规划结果中的单个目标罐 */
export interface PlannedTarget extends PlanTargetInput {
  /** 本次实际倒入量 L */
  moveVolumeL: number
  /** 倒入后该罐内存放本批次的总量 L */
  afterVolumeL: number
}

/** 按罐容量算出的分罐计划 */
export interface RackPlan {
  sourceTankId: string
  /** 源罐倒出前的量 L */
  sourceVolumeL: number
  targets: PlannedTarget[]
  /** 实际搬出总量 L */
  movedTotalL: number
  /** 留在原罐的余量 L */
  leftVolumeL: number
}

/** 一次倒罐请求（由倒罐对话框提交） */
export interface RackRequest {
  batchId: string
  sourceTankId: string
  /** 目标罐 id 列表（按顺序灌；自动去重并排除源罐） */
  targetTankIds: string[]
  /** 作业日期 YYYY-MM-DD */
  date: string
  durationMin: number
  operator: string
  /** 打开对话框时批次的 updatedAt：并发提交时用于检测批次已被另一个页面改动 */
  expectedBatchUpdatedAt?: number | null
}

/** 分罐行的确定性 id（同批次同罐唯一，upsert 幂等） */
export function splitId(batchId: string, tankId: string): string {
  return `split:${batchId}:${tankId}`
}
