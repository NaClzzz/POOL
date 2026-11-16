import { describe, expect, it } from 'vitest'
import { KeyedSerial } from '@/server/rooms/keyed-serial'

/** 用显式放行控制并发先后，避免依赖计时器速度。 */
function gate() {
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return { ready, release }
}

describe('房间串行协调', () => {
  it('共享键按进入顺序执行，无关房间可以并行', async () => {
    const serial = new KeyedSerial(),
      entered = gate(),
      finish = gate()
    const events: string[] = []
    const first = serial.run(['room:a', 'room:b', 'room:a'], async () => {
      events.push('first')
      entered.release()
      await finish.ready
      events.push('first-done')
    })
    await entered.ready
    const second = serial.run(['room:b', 'room:a'], async () => {
      events.push('second')
    })
    await serial.run(['room:c'], async () => {
      events.push('independent')
    })
    expect(events).toEqual(['first', 'independent'])
    finish.release()
    await Promise.all([first, second])
    expect(events).toEqual(['first', 'independent', 'first-done', 'second'])
  })

  it('失败释放串行键，排队操作和后续重用仍能完成', async () => {
    const serial = new KeyedSerial(),
      entered = gate(),
      finish = gate()
    const failed = serial.run(['room:a'], async () => {
      entered.release()
      await finish.ready
      throw new Error('写入失败')
    })
    const rejected = expect(failed).rejects.toThrow('写入失败')
    await entered.ready
    const queued = serial.run(['room:a'], async () => 'next')
    finish.release()
    await rejected
    expect(await queued).toBe('next')
    await serial.drain()
    expect(await serial.run(['room:a'], async () => 'reused')).toBe('reused')
  })

  it('drain 等待在途命令以及命令内新增的协调操作', async () => {
    const serial = new KeyedSerial(),
      entered = gate(),
      finish = gate()
    const events: string[] = []
    const pending = serial.run(['user:a'], async () => {
      entered.release()
      await finish.ready
      await serial.run(['room:a'], async () => {
        events.push('saved')
      })
    })
    await entered.ready
    const drained = serial.drain().then(() => {
      events.push('drained')
    })
    expect(events).toEqual([])
    finish.release()
    await Promise.all([pending, drained])
    expect(events).toEqual(['saved', 'drained'])
  })
})
