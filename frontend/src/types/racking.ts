/**
 * 倒罐流水：一次倒罐的完整搬运记录。
 * 与作业（Operation）一一对应：提交倒罐时在同一事务内同时写作业、分罐、罐位和本流水。
 */
export interface Racking {
  id: string
  /** 对应的作业 id（作业类型固定为「倒罐」） */
  operationId: string
  /** 倒罐批次 */
  batchId: string
  /** 倒出罐 */
  fromTankId: string
  /** 计划倒出量（L，即表单填写量；实际搬运量受目标罐总空余容量限制） */
  plannedVolumeL: number
  /** 实际搬运总量（L）。目标罐装不下时小于计划量，余量留在原罐 */
  movedVolumeL: number
  /** 留在原罐的量（L） */
  remainingVolumeL: number
  /** 分罐明细：每个目标罐装了多少 */
  splits: RackingSplit[]
  /** 倒罐日期 YYYY-MM-DD */
  date: string
}

/** 单罐分配明细 */
export interface RackingSplit {
  tankId: string
  /** 本次倒入该罐的量（L） */
  volumeL: number
}
