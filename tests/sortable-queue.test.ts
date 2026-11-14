// @vitest-environment jsdom
import { act, createElement, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DragDropProvider } from '@dnd-kit/react'
import { trackKey, type Track } from '@/contracts/domain'

const dnd = vi.hoisted(() => ({
  handlers: {} as ComponentProps<typeof DragDropProvider>,
}))
// 只替换拖拽事件边界，列表挂载、滚动范围和业务操作使用真实 React 与 TanStack Virtual。
vi.mock('@dnd-kit/react', () => ({
  DragDropProvider: (props: ComponentProps<typeof DragDropProvider>) => {
    dnd.handlers = props
    return props.children
  },
  DragOverlay: () => null,
}))
vi.mock('@dnd-kit/react/sortable', () => ({
  useSortable: () => ({ ref: () => undefined, handleRef: () => undefined, isDragging: false }),
}))
import { SortableQueue } from '@/features/music/sortable-queue'

const tracks: Track[] = Array.from({ length: 500 }, (_, index) => ({
  source: 'netease',
  source_id: String(index),
  title: `歌曲${index}`,
  author: '作者',
  album: null,
  cover_url: null,
  duration_ms: 10000,
  extra: null,
}))
const onSelect = vi.fn(),
  onRemove = vi.fn(),
  onMove = vi.fn()
let root: Root, host: HTMLDivElement

/** 使用与两个抽屉一致的外部滚动容器，不额外创建列表内滚动区域。 */
function Probe({
  personal = true,
  items = tracks,
  currentIndex = 0,
}: {
  personal?: boolean
  items?: Track[]
  currentIndex?: number
}) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  return createElement(
    'div',
    { ref: setScrollElement, 'data-scroll': true },
    createElement(SortableQueue, {
      tracks: items,
      scrollElement,
      currentIndex: personal ? currentIndex : undefined,
      onSelect: personal ? onSelect : undefined,
      onRemove,
      onMove,
    }),
  )
}

/** 发出受控拖拽协议事件，专门验证虚拟列表之外的完整排序索引。 */
async function dragEvent(
  name: 'onDragStart' | 'onDragOver' | 'onDragEnd',
  from: number,
  to: number | null,
  canceled = false,
) {
  const event = {
    operation: {
      source: { id: trackKey(tracks[from]) },
      target: to === null ? null : { id: trackKey(tracks[to]) },
    },
    canceled,
  }
  const handler = dnd.handlers[name] as (event: unknown) => void
  await act(async () => handler(event))
}

/** 通过真实滚动事件更新虚拟范围，模拟浏览器已完成的滚动。 */
async function scrollTo(index: number) {
  await act(async () => {
    const scroller = host.querySelector<HTMLDivElement>('[data-scroll]')!
    scroller.scrollTop = index * 63
    scroller.dispatchEvent(new Event('scroll'))
  })
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  onSelect.mockReset()
  onRemove.mockReset()
  onMove.mockReset()
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(315)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(31500)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('个人及房间播放列表虚拟化', () => {
  it.each([true, false])(
    '500 首仅挂载可视行，滚动后删除使用完整索引（个人：%s）',
    async (personal) => {
      await act(async () => root.render(createElement(Probe, { personal })))
      expect(host.querySelectorAll('[role="listitem"]').length).toBeLessThan(20)
      await scrollTo(400)
      expect(host.querySelectorAll('[role="listitem"]').length).toBeLessThan(25)
      const row = host.querySelector('[data-track-key="netease:400"]')!
      expect(row.getAttribute('aria-posinset')).toBe('401')
      expect(row.getAttribute('aria-setsize')).toBe('500')
      await act(async () =>
        row.querySelector<HTMLButtonElement>('[aria-label="移除 歌曲400"]')!.click(),
      )
      expect(onRemove).toHaveBeenCalledWith(tracks[400], 400)
      if (personal) {
        await act(async () =>
          row.querySelector<HTMLButtonElement>('[aria-label="播放 歌曲400"]')!.click(),
        )
        expect(onSelect).toHaveBeenCalledWith(400)
      }
    },
  )

  it('滚动时保留焦点行，当前歌曲仍禁用拖动和移除', async () => {
    await act(async () => root.render(createElement(Probe, { currentIndex: 2 })))
    const current = host.querySelector('[data-track-key="netease:2"]')!
    expect(current.querySelector<HTMLButtonElement>('[aria-label="移除 歌曲2"]')!.disabled).toBe(
      true,
    )
    expect(
      current.querySelector<HTMLButtonElement>('[aria-label="拖拽排序 歌曲2"]')!.disabled,
    ).toBe(true)
    await act(async () =>
      current.querySelector<HTMLButtonElement>('[aria-label="播放 歌曲2"]')!.focus(),
    )
    await scrollTo(400)
    expect(host.querySelector('[data-track-key="netease:2"]')).not.toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('播放 歌曲2')
  })

  it('跨虚拟范围拖动保留源行，落下仅提交一次完整位置；取消不提交', async () => {
    await act(async () => root.render(createElement(Probe)))
    await dragEvent('onDragStart', 1, 1)
    await scrollTo(400)
    expect(host.querySelector('[data-track-key="netease:1"]')).not.toBeNull()
    await dragEvent('onDragOver', 1, 400)
    expect(onMove).not.toHaveBeenCalled()
    expect(host.querySelector('[data-track-key="netease:1"]')?.getAttribute('aria-posinset')).toBe(
      '401',
    )
    await dragEvent('onDragEnd', 1, 400)
    expect(onMove).toHaveBeenCalledExactlyOnceWith(tracks[1], 400)
    await dragEvent('onDragStart', 1, 1)
    await dragEvent('onDragOver', 1, 401)
    await dragEvent('onDragEnd', 1, 401, true)
    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it('房间歌单在拖动期间更新后，不提交过期排序', async () => {
    await act(async () => root.render(createElement(Probe, { personal: false })))
    await dragEvent('onDragStart', 1, 1)
    await dragEvent('onDragOver', 1, 8)
    await act(async () =>
      root.render(createElement(Probe, { personal: false, items: tracks.slice(1) })),
    )
    await dragEvent('onDragEnd', 1, 8)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('小队列保留普通列表，支持排序取消及原有操作', async () => {
    await act(async () => root.render(createElement(Probe, { items: tracks.slice(0, 10) })))
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(10)
    await dragEvent('onDragStart', 1, 1)
    await dragEvent('onDragOver', 1, 8)
    await dragEvent('onDragEnd', 1, null)
    expect(onMove).not.toHaveBeenCalled()
    expect(host.querySelector('[data-track-key="netease:1"]')?.getAttribute('aria-posinset')).toBe(
      '2',
    )
  })
})
