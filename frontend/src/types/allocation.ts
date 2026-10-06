/**
 * 分罐占用：倒罐后一个批次可同时分散在多个发酵罐里。
 * 每个在罐批次按罐产生若干行，全部行的 volumeL 之和等于该批次当前在罐量。
 * 罐位是否被占用以本表为准（Tank.state 仅作可读冗余状态）。
 */
export interface TankAllocation {
  id: string
  /** 占用批次 */
  batchId: string
  /** 所在发酵罐 */
  tankId: string
  /** 该罐内属于该批次的酒量（L） */
  volumeL: number
}
