/**
 * 倒罐 store：提交倒罐事务（作业 + 分罐 + 罐位一次性写入）。
 * 纯分罐计划预览走 utils/racking 的 planRacking，不碰数据库。
 */
import { defineStore } from 'pinia'
import { performRacking, RackConflictError, type RackingResult } from '@/utils/db'
import type { RackRequest } from '@/types/split'

export class RackingStoppedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RackingStoppedError'
  }
}

export const useRackingStore = defineStore('racking', () => {
  /**
   * 执行倒罐。
   * - 罐位被其它批次先占、或批次已被另一页面改动：抛 RackingStoppedError，
   *   页面应停下并提示用户刷新，不做任何静默重试（事务已整体回滚，无半截记录）。
   */
  async function submit(request: RackRequest): Promise<RackingResult> {
    try {
      return await performRacking(request)
    } catch (error) {
      if (error instanceof RackConflictError) {
        throw new RackingStoppedError(error.message)
      }
      throw error
    }
  }

  return { submit }
})
