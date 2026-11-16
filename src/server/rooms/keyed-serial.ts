/** 串行化相同键的异步操作，结束即释放键，不保留已完成请求。 */
export class KeyedSerial {
  private pending = new Map<string, Promise<unknown>>()
  /** 按稳定键序依次等待在途操作，完成后释放占位。 */
  async run<T>(keys: string[], action: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort()
    const run = (index: number): Promise<T> => {
      if (index === sorted.length) return action()
      const key = sorted[index]
      const previous = this.pending.get(key) ?? Promise.resolve()
      const next = previous.catch(() => undefined).then(() => run(index + 1))
      this.pending.set(key, next)
      void next
        .finally(() => {
          if (this.pending.get(key) === next) this.pending.delete(key)
        })
        .catch(() => undefined)
      return next
    }
    return run(0)
  }
  /** 退出前等待断开处理与在途数据库操作完成。 */
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending.values()])
  }
}
