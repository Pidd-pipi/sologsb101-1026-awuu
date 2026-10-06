/** 作业类型 */
export type OperationType = '倒罐' | '压帽' | '淋皮'
/** 作业状态 */
export type OperationState = '计划' | '已完成'

/**
 * 倒罐去向明细：作业执行后由分罐事实快照生成。
 * 一次倒罐可能拆进多个目标罐，余下的留在原罐。
 */
export interface RackDetail {
  /** 倒出的源罐 id */
  sourceTankId: string
  /** 目标罐 id 与该罐倒入量 L */
  targets: Array<{ tankId: string; moveVolumeL: number }>
  /** 留在源罐的余量 L */
  leftVolumeL: number
}

/** 车间作业：倒罐 / 压帽 / 淋皮 */
export interface Operation {
  id: string
  /** 所属批次 */
  batchId: string
  /** 作业类型 */
  type: OperationType
  /** 计划日期 YYYY-MM-DD */
  date: string
  /** 时长（分钟） */
  durationMin: number
  /** 操作人 */
  operator: string
  /** 作业状态 */
  state: OperationState
  /** 拖拽调序后的先后次序（从 1 开始） */
  seq: number
  /** 仅倒罐：实际搬入的目标罐与分罐量快照；其它作业为 null */
  rackDetail?: RackDetail | null
}

export const OPERATION_TYPES: OperationType[] = ['倒罐', '压帽', '淋皮']
export const OPERATION_STATES: OperationState[] = ['计划', '已完成']

export function createEmptyOperation(): Omit<Operation, 'id' | 'seq'> {
  return {
    batchId: '',
    type: '倒罐',
    date: new Date().toISOString().slice(0, 10),
    durationMin: 45,
    operator: '',
    state: '计划'
  }
}
