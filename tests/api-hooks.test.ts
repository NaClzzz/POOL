import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountUser } from '@/contracts/auth'
import type { LikedTrack, Track } from '@/contracts/domain'
import type { ImportLikesResult } from '@/contracts/music'

const { identity } = vi.hoisted(() => ({ identity: { user: null as AccountUser | null } }))
const notifications = vi.hoisted(() => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/lib/notifications', () => notifications)
vi.mock('@/stores/session', () => ({
  useSession: Object.assign(
    (select: (state: { user: AccountUser | null }) => unknown) => select(identity),
    { getState: () => identity },
  ),
}))
vi.mock('@/lib/auth-client', () => ({ authClient: { getSession: vi.fn() } }))

import {
  likesApi,
  useLikes,
  useAddLike,
  useRemoveLike,
  useClearLikes,
  useImportLikes,
} from '@/features/likes/api'
import { musicApi, useMusicSearch } from '@/features/music/api'
import { roomsApi, useDeleteRoomHistory } from '@/features/room/api'
import { HttpError } from '@/lib/http'

const track: Track = {
  source: 'netease',
  source_id: '123',
  title: '歌曲',
  author: null,
  album: null,
  duration_ms: null,
  cover_url: null,
  extra: null,
}
const liked: LikedTrack = { ...track, addedAt: '2026-11-12T00:00:00.000Z' }
const imported: ImportLikesResult = {
  added: 1,
  duplicates: 0,
  failed: 0,
  capacitySkipped: 0,
  remainingCapacity: 499,
  hasMore: false,
}
let client: QueryClient

/** 用真实 QueryClient 和 React 渲染执行 hooks；通过返回的原始方法驱动查询及 mutation。 */
function renderHook<T>(hook: () => T): T {
  let result!: T
  /** 仅捕获 hook 结果，不额外模拟 TanStack Query 生命周期。 */
  function Probe() {
    result = hook()
    return null
  }
  renderToString(createElement(QueryClientProvider, { client }, createElement(Probe)))
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
  identity.user = { id: 'user-a', email: 'a@example.com', name: 'A' }
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 20000 }, mutations: { retry: false } },
  })
})
afterEach(() => {
  client.clear()
  vi.restoreAllMocks()
})

describe('统一业务 Query hooks', () => {
  it('多个 useLikes 共用用户查询及取消信号，缓存可直接复用', async () => {
    const list = vi.spyOn(likesApi, 'list').mockResolvedValue([liked])
    const first = renderHook(() => useLikes())
    const second = renderHook(() => useLikes())
    await Promise.all([first.refetch(), second.refetch()])
    expect(list).toHaveBeenCalledTimes(1)
    expect(list.mock.calls[0][0]).toBeInstanceOf(AbortSignal)
    expect(client.getQueryData(['likes', 'user-a'])).toEqual([liked])
    expect(renderHook(() => useLikes()).data).toEqual([liked])
  })

  it('未登录或明确禁用时不自动查询，换号使用独立缓存键', async () => {
    const list = vi.spyOn(likesApi, 'list').mockResolvedValue([])
    expect(renderHook(() => useLikes({ enabled: false })).isEnabled).toBe(false)
    identity.user = null
    expect(renderHook(() => useLikes()).isEnabled).toBe(false)
    expect(list).not.toHaveBeenCalled()
    identity.user = { id: 'user-b', email: 'b@example.com', name: 'B' }
    await renderHook(() => useLikes()).refetch()
    expect(client.getQueryData(['likes', 'user-b'])).toEqual([])
    expect(client.getQueryData(['likes', 'user-a'])).toBeUndefined()
  })

  it('查询取消会传给底层请求，不重试或保留成功数据', async () => {
    let signal: AbortSignal | undefined
    vi.spyOn(likesApi, 'list').mockImplementation((value) => {
      signal = value
      return new Promise((_, reject) =>
        value!.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), {
          once: true,
        }),
      )
    })
    const pending = renderHook(() => useLikes()).refetch()
    await client.cancelQueries({ queryKey: ['likes', 'user-a'] })
    await pending
    expect(signal?.aborted).toBe(true)
    expect(client.getQueryData(['likes', 'user-a'])).toBeUndefined()
  })

  it('新增和取消都先刷新本人缓存，再执行可选成功回调，不影响另一用户', async () => {
    client.setQueryData(['likes', 'user-a'], [liked])
    client.setQueryData(['likes', 'user-b'], [])
    vi.spyOn(likesApi, 'add').mockResolvedValue({ item: liked, added: true })
    vi.spyOn(likesApi, 'remove').mockResolvedValue(null)
    const addSuccess = vi.fn((data, value) => {
      expect(client.getQueryState(['likes', 'user-a'])?.isInvalidated).toBe(true)
      expect(data.added).toBe(true)
      expect(value).toBe(track)
    })
    await renderHook(() => useAddLike({ onSuccess: addSuccess })).mutateAsync(track)
    expect(addSuccess).toHaveBeenCalledOnce()
    expect(notifications.notifySuccess).toHaveBeenCalledExactlyOnceWith('已加入喜欢')
    expect(client.getQueryState(['likes', 'user-b'])?.isInvalidated).toBe(false)
    client.setQueryData(['likes', 'user-a'], [liked])
    await renderHook(() => useRemoveLike()).mutateAsync(track)
    expect(likesApi.remove).toHaveBeenCalledWith(track, expect.anything())
    expect(client.getQueryState(['likes', 'user-a'])?.isInvalidated).toBe(true)
  })

  it('清空回调等待公共缓存刷新后执行，导入通过变量提交音源及原始链接', async () => {
    client.setQueryData(['likes', 'user-a'], [liked])
    vi.spyOn(likesApi, 'clear').mockResolvedValue(null)
    vi.spyOn(likesApi, 'import').mockResolvedValue(imported)
    const closeDialog = vi.fn(() => {
      expect(client.getQueryState(['likes', 'user-a'])?.isInvalidated).toBe(true)
    })
    await renderHook(() => useClearLikes({ onSuccess: closeDialog })).mutateAsync()
    expect(likesApi.clear).toHaveBeenCalledWith()
    expect(closeDialog).toHaveBeenCalledOnce()
    const url = 'https://music.163.com/playlist?id=123'
    const input = { source: 'netease' as const, url }
    const success = vi.fn()
    const result = await renderHook(() => useImportLikes({ onSuccess: success })).mutateAsync(input)
    expect(result).toEqual(imported)
    expect(likesApi.import).toHaveBeenCalledWith(input, expect.anything())
    expect(success).toHaveBeenCalledWith(imported, input)
  })

  it('失败时保留错误，不执行成功回调或误刷新查询', async () => {
    client.setQueryData(['likes', 'user-a'], [liked])
    const error = new Error('导入失败')
    vi.spyOn(likesApi, 'import').mockRejectedValue(error)
    const success = vi.fn()
    await expect(
      renderHook(() => useImportLikes({ onSuccess: success })).mutateAsync({
        source: 'netease',
        url: 'invalid',
      }),
    ).rejects.toBe(error)
    expect(success).not.toHaveBeenCalled()
    expect(notifications.notifyError).toHaveBeenCalledExactlyOnceWith(error)
    expect(client.getQueryState(['likes', 'user-a'])?.isInvalidated).toBe(false)
  })

  it('异步操作完成时若已换号，只使原账号缓存失效，不触发新页面动作', async () => {
    client.setQueryData(['likes', 'user-a'], [liked])
    client.setQueryData(['likes', 'user-b'], [])
    let finish!: (value: null) => void
    const remove = vi.spyOn(likesApi, 'remove').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const success = vi.fn()
    const pending = renderHook(() => useRemoveLike({ onSuccess: success })).mutateAsync(track)
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
    identity.user = { id: 'user-b', email: 'b@example.com', name: 'B' }
    finish(null)
    await pending
    expect(client.getQueryState(['likes', 'user-a'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['likes', 'user-b'])?.isInvalidated).toBe(false)
    expect(success).not.toHaveBeenCalled()
    expect(notifications.notifySuccess).not.toHaveBeenCalled()
  })

  it('空关键词和未登录禁用搜索，源和关键词构成不同查询键', () => {
    expect(renderHook(() => useMusicSearch('netease', '  ')).isEnabled).toBe(false)
    renderHook(() => useMusicSearch('netease', ' 晴天 '))
    renderHook(() => useMusicSearch('bilibili', '晴天'))
    expect(client.getQueryState(['music', 'search', 'netease', '晴天'])).toBeDefined()
    expect(client.getQueryState(['music', 'search', 'bilibili', '晴天'])).toBeDefined()
    identity.user = null
    expect(renderHook(() => useMusicSearch('netease', '晴天')).isEnabled).toBe(false)
  })

  it('搜索统一每页 30 条，加载下一页按服务端分页信息停止', async () => {
    const search = vi
      .spyOn(musicApi, 'search')
      .mockImplementation(async (_source, _q, offset = 0) => ({
        items: [track],
        offset,
        limit: 30,
        total: 31,
        hasMore: offset === 0,
      }))
    const query = renderHook(() => useMusicSearch('netease', '晴天'))
    await query.refetch()
    const result = await query.fetchNextPage()
    expect(search.mock.calls.map((args) => args.slice(0, 4))).toEqual([
      ['netease', '晴天', 0, 30],
      ['netease', '晴天', 30, 30],
    ])
    expect(search.mock.calls[0][4]).toBeInstanceOf(AbortSignal)
    expect(result.data?.pages).toHaveLength(2)
    expect(result.hasNextPage).toBe(false)
  })
  it.each(['INVALID_INPUT', 'INVALID_PLAYLIST_LINK'])(
    '列表查询失败和导入 %s 校验交给对应区域，不弹通知',
    async (code) => {
      vi.spyOn(likesApi, 'list').mockRejectedValue(new Error('列表失败'))
      await expect(renderHook(() => useLikes()).refetch({ throwOnError: true })).rejects.toThrow(
        '列表失败',
      )
      const invalid = new HttpError(code, '请输入有效链接', 400, null)
      vi.spyOn(likesApi, 'import').mockRejectedValue(invalid)
      await expect(
        renderHook(() => useImportLikes()).mutateAsync({ source: 'netease', url: 'bad' }),
      ).rejects.toBe(invalid)
      expect(notifications.notifyError).not.toHaveBeenCalled()
    },
  )
  it('换号后旧操作失败不弹通知', async () => {
    let fail!: (error: Error) => void
    const remove = vi.spyOn(likesApi, 'remove').mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    )
    const pending = renderHook(() => useRemoveLike()).mutateAsync(track)
    const settled = expect(pending).rejects.toThrow('旧操作失败')
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
    identity.user = { id: 'user-b', email: 'b@example.com', name: 'B' }
    fail(new Error('旧操作失败'))
    await settled
    expect(notifications.notifyError).not.toHaveBeenCalled()
  })
  it('删除历史清除本人详情与总结缓存，通知一次后执行页面回调', async () => {
    client.setQueryData(['room-history-detail', 'user-a', 'room'], {})
    client.setQueryData(['room-summary', 'user-a', 'room'], {})
    vi.spyOn(roomsApi, 'deleteHistory').mockResolvedValue(null)
    const success = vi.fn()
    await renderHook(() => useDeleteRoomHistory({ onSuccess: success })).mutateAsync('room')
    expect(client.getQueryData(['room-summary', 'user-a', 'room'])).toBeUndefined()
    expect(client.getQueryData(['room-history-detail', 'user-a', 'room'])).toBeUndefined()
    expect(notifications.notifySuccess).toHaveBeenCalledExactlyOnceWith('已删除这条房间历史')
    expect(success).toHaveBeenCalledExactlyOnceWith(null, 'room')
  })
})
