// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayer } from '@/stores/player'
import { catalog } from './fixtures/tracks'

vi.mock('@/lib/api-client', () => ({
  useLikes: () => ({ data: [] }),
  useAddLike: () => ({ isPending: false }),
  useRemoveLike: () => ({ isPending: false }),
}))

import { PersonalPlayerDock } from '@/features/player/player-dock'

let root: Root, host: HTMLDivElement, control: HTMLElement

/** 通过真实滑块的指针事件验证预览与音频定位，不直接调用组件回调。 */
async function pointer(target: EventTarget, type: string, clientX: number) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX,
        clientY: 10,
      }),
    )
  })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  usePlayer.getState().reset()
  usePlayer.getState().play(catalog[0], catalog.slice(0, 2))
  usePlayer.setState({ position: 30, duration: 120, seekTo: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(PersonalPlayerDock)))
  control = host.querySelector<HTMLElement>('[data-slot="slider"]')!
    .firstElementChild as HTMLElement
  vi.spyOn(control, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 20))
  // jsdom 不实现指针捕获；滑块的交互和提交仍由 Base UI 处理。
  Object.assign(control, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    releasePointerCapture: vi.fn(),
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  usePlayer.getState().reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('个人播放进度提交', () => {
  it('拖动只预览，音频进度更新不覆盖草稿，松手后才定位', async () => {
    await pointer(control, 'pointerdown', 100)
    await pointer(document, 'pointermove', 200)
    await pointer(document, 'pointermove', 300)
    expect(usePlayer.getState()).toMatchObject({ position: 30, seekTo: null, playing: true })
    const slider = host.querySelector('[data-slot="slider"]')!
    expect(slider.querySelector('input')!.value).toBe('90')
    expect(slider.previousElementSibling!.textContent).toBe('1:30')

    await act(async () => usePlayer.setState({ position: 31 }))
    expect(slider.querySelector('input')!.value).toBe('90')
    await pointer(document, 'pointerup', 300)
    expect(usePlayer.getState()).toMatchObject({ position: 90, seekTo: 90, playing: true })

    await act(async () => usePlayer.setState({ position: 91, seekTo: null }))
    expect(slider.querySelector('input')!.value).toBe('91')
  })

  it('拖动中切歌会清空预览，旧手势松开不定位新曲目', async () => {
    await pointer(control, 'pointerdown', 100)
    await pointer(document, 'pointermove', 300)
    await act(async () => usePlayer.getState().next())
    await pointer(document, 'pointerup', 300)
    expect(usePlayer.getState()).toMatchObject({ index: 1, position: 0, seekTo: 0 })
    expect(host.querySelector<HTMLInputElement>('[data-slot="slider"] input')!.value).toBe('0')
  })
})
