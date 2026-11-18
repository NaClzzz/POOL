// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from '@/components/ui/toast'
import { notifyError, notifySuccess } from '@/lib/notifications'
import { HttpError } from '@/lib/http'

let root: Root
let host: HTMLDivElement

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(Toaster)))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('短暂操作通知', () => {
  it('成功三秒、错误五秒，保留限流等待时间，取消不弹通知', async () => {
    const add = vi.spyOn(toast, 'add')
    await act(async () => {
      notifySuccess('保存成功')
      notifyError(new HttpError('RATE_LIMITED', '请求过于频繁', 429, 12))
      notifyError(new DOMException('取消', 'AbortError'))
    })
    expect(add).toHaveBeenCalledTimes(2)
    expect(add).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: '保存成功',
        type: 'success',
        timeout: 3000,
      }),
    )
    expect(add).toHaveBeenNthCalledWith(2, {
      title: '请求过于频繁',
      description: '请在 12 秒后重试',
      type: 'error',
      timeout: 5000,
    })
    expect(document.body.textContent).toContain('请求过于频繁')
  })
  it('每条通知都有可访问的关闭按钮，点击即可关闭', async () => {
    await act(async () => notifySuccess('操作完成'))
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="关闭通知"]')
    expect(close).not.toBeNull()
    await act(async () => close!.click())
    const notification = document.querySelector('[data-slot="toast"]')
    expect(!notification || notification.hasAttribute('data-ending-style')).toBe(true)
  })
})
