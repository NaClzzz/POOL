// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomHistoryDetail } from '@/contracts/room'

const query = vi.hoisted(() => ({ useRoomHistoryDetail: vi.fn() }))
vi.mock('@/lib/api-client', () => query)
vi.mock('@/features/ai/room-summary', () => ({
  /** 保留总结区域作为独立生成组件，页头测试不触发模型请求。 */
  RoomSummary: ({ roomId }: { roomId: string }) =>
    createElement('section', { 'aria-label': '房间总结', 'data-room-id': roomId }),
}))
import { HistoryDetail } from '@/features/room-history/history-detail'

/** 历史详情使用离线参与者，避免将当前在线人数当作整场参与人数。 */
let detail: RoomHistoryDetail

/** 渲染真实页面结构，检查服务端资料与共享总结的展示边界。 */
function renderDetail() {
  query.useRoomHistoryDetail.mockReturnValue({ isPending: false, isError: false, data: detail })
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(createElement(HistoryDetail, { roomId: detail.roomId }))
  return host
}

beforeEach(() => {
  detail = {
    roomId: 'archived-room',
    roomCode: 'pool-test',
    name: '夜间电台',
    tag: '独立音乐',
    ownerId: 'a',
    ownerName: '甲',
    createdBy: 'a',
    memberCount: 0,
    maxMembers: 10,
    maxStageMembers: 5,
    isPasswordProtected: false,
    lastActiveAt: '2026-11-19T12:00:00.000Z',
    lastJoinedAt: '2026-11-19T11:00:00.000Z',
    status: 'ended',
    endedAt: '2026-11-19T12:00:00.000Z',
    expiresAt: '2026-11-26T12:00:00.000Z',
    participants: [
      { userId: 'a', name: '甲', image: null },
      { userId: 'b', name: '乙', image: null },
    ],
    playedCount: 12,
    messageCount: 34,
  }
})

describe('房间总结详情排版与统计', () => {
  it('展示房间名、标签、结束和到期时间、参与者与互动数据，并保留原总结组件', () => {
    const host = renderDetail()
    expect(host.querySelector('h1')?.textContent).toBe('夜间电台')
    expect(host.querySelector('header')?.textContent).toContain('独立音乐')
    expect(host.querySelector('time[datetime="2026-11-19T12:00:00.000Z"]')?.textContent).toContain(
      '结束',
    )
    expect(host.querySelector('time[datetime="2026-11-26T12:00:00.000Z"]')?.textContent).toMatch(
      /11.*26.*到期/,
    )
    expect(host.querySelectorAll('[data-slot="avatar"]')).toHaveLength(2)
    expect(host.querySelector('[aria-label="房间互动数据"]')?.textContent).toContain('参与人数 2')
    expect(host.querySelector('[aria-label="房间互动数据"]')?.textContent).toContain('播放记录 12')
    expect(host.querySelector('[aria-label="房间互动数据"]')?.textContent).toContain('聊天条数 34')
    expect(host.querySelector('[aria-label="房间总结"]')?.getAttribute('data-room-id')).toBe(
      'archived-room',
    )
  })
  it('记录达到保留上限时显示加号，头像组用剩余人数收起更多参与者', () => {
    detail.playedCount = 500
    detail.messageCount = 10_000
    detail.participants = Array.from({ length: 12 }, (_, i) => ({
      userId: String(i),
      name: `成员${i}`,
      image: null,
    }))
    const host = renderDetail()
    const stats = host.querySelector('[aria-label="房间互动数据"]')!.textContent
    expect(stats).toContain('参与人数 12')
    expect(stats).toContain('播放记录 500+')
    expect(stats).toContain('聊天条数 10000+')
    expect(host.querySelectorAll('[data-slot="avatar"]')).toHaveLength(8)
    expect(host.querySelector('[aria-label="另有 4 位参与者"]')?.textContent).toBe('+4')
  })
  it('没有互动时显示真实零值，活动房不提供总结生成', () => {
    detail.status = 'active'
    detail.endedAt = null
    detail.expiresAt = null
    detail.participants = []
    detail.playedCount = 0
    detail.messageCount = 0
    const host = renderDetail()
    expect(host.querySelector('[aria-label="房间互动数据"]')?.textContent).toContain('参与人数 0')
    expect(host.querySelector('[aria-label="房间互动数据"]')?.textContent).toContain('播放记录 0')
    expect(host.querySelector('[aria-label="房间互动数据"]')?.textContent).toContain('聊天条数 0')
    expect(host.querySelector('[aria-label="房间总结"]')).toBeNull()
    expect(host.textContent).toContain('房间结束后可生成总结')
    expect(host.querySelector('a[href="/rooms/pool-test"]')).not.toBeNull()
  })
})
