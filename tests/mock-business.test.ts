import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  fillLikes,
  generateText,
  getDatabase,
  resetDemo,
  setScenario,
  setMockUser,
} from '@/mocks/api'
import { catalog, DEMO_EMAIL, DEMO_ROOM_PASSWORD } from '@/mocks/fixtures'
import { MockRoomSession } from '@/mocks/room-session'
import { trackKey, type RoomSnapshot } from '@/contracts/domain'

const sessions: MockRoomSession[] = []

beforeEach(async () => {
  resetDemo()
  setMockUser({ id: DEMO_EMAIL, email: DEMO_EMAIL, name: '知更' })
})

afterEach(() => {
  for (const session of sessions) session.dispose()
  sessions.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('喜欢列表与导入的一致性', () => {
  it('mock 只使用桥接的用户主键，不持久化认证会话或密码', async () => {
    const local = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => local.set(key, value),
      },
    })
    setMockUser({ id: 'stable-user-id', email: 'new@pool.local', name: '新用户' })
    await api.addLike(catalog[0])
    const saved = [...local.values()].join('')
    expect(saved).toContain('stable-user-id')
    expect(saved).not.toContain('new@pool.local')
    expect(saved).not.toContain('"password"')
    expect(saved).not.toContain('"session"')
  })

  it('重复收藏不重复写入或更新添加时间', async () => {
    const before = await api.likes()
    expect(await api.addLike(catalog[0])).toEqual({ added: false })
    expect(await api.likes()).toEqual(before)
  })

  it('并发收藏仍然不超过 500 首，身份不重复', async () => {
    fillLikes()
    await Promise.allSettled([
      api.addLike(catalog[30]),
      api.addLike(catalog[31]),
      api.addLike(catalog[32]),
    ])
    const likes = await api.likes()
    expect(likes).toHaveLength(500)
    expect(new Set(likes.map(trackKey)).size).toBe(500)
  })

  it('演示歌单导入恰好填满剩余容量，并反馈跳过项', async () => {
    fillLikes()
    const result = await api.importLikes('https://music.163.com/#/playlist?id=3778678')
    expect(result.added).toBe(2)
    expect(result.capacitySkipped).toBeGreaterThan(0)
    expect(result.remainingCapacity).toBe(0)
    expect(await api.likes()).toHaveLength(500)
  })

  it('取消喜欢幂等，并拒绝非网易云歌单链接', async () => {
    await api.removeLike(catalog[0])
    await api.removeLike(catalog[0])
    expect((await api.likes()).some((t) => trackKey(t) === trackKey(catalog[0]))).toBe(false)
    await expect(api.importLikes('https://example.com/playlist')).rejects.toMatchObject({
      code: 'INVALID_PLAYLIST_LINK',
    })
  })

  it('登录账号之间的喜欢数据相互隔离', async () => {
    setMockUser({ id: 'other-user-id', email: 'other@pool.local', name: '其他用户' })
    expect(await api.likes()).toHaveLength(0)
    await api.addLike(catalog[20])
    setMockUser({ id: DEMO_EMAIL, email: DEMO_EMAIL, name: '知更' })
    expect(await api.likes()).toHaveLength(12)
  })
})

describe('房间历史与总结权限', () => {
  it('AI 全站最多同时启动 10 个，超过不排队', async () => {
    vi.useFakeTimers()
    const db = getDatabase()
    const template = db.rooms.find((r) => r.roomId === 'room-evening')!
    for (let i = 0; i < 11; i++) {
      db.rooms.push({ ...template, roomId: `summary-limit-${i}` })
      db.history[DEMO_EMAIL].push({
        roomId: `summary-limit-${i}`,
        lastJoinedAt: new Date().toISOString(),
      })
    }
    const requests = Array.from({ length: 10 }, (_, i) =>
      generateText('summary', `summary-limit-${i}`, () => {}, new AbortController().signal),
    )
    await expect(
      generateText('summary', 'summary-limit-10', () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AI_BUSY' })
    await vi.runAllTimersAsync()
    await Promise.all(requests)
    expect(requests).toHaveLength(10)
  })

  it('用户取消不产生成功锁定，之后能够手动重试', async () => {
    const controller = new AbortController()
    const request = generateText('summary', 'room-evening', () => {}, controller.signal)
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(getDatabase().summaries['room-evening'].status).toBe('failed')
    await generateText('summary', 'room-evening', () => {}, new AbortController().signal)
    expect(getDatabase().summaries['room-evening'].status).toBe('succeeded')
  })

  it('密码错误不会留下历史，正确密码才能加入', async () => {
    await expect(api.joinRoom('pool-coast', 'wrong')).rejects.toMatchObject({
      code: 'ROOM_PASSWORD_REQUIRED',
    })
    expect((await api.history()).some((h) => h.roomCode === 'pool-coast')).toBe(false)
    await api.joinRoom('pool-coast', DEMO_ROOM_PASSWORD)
    expect((await api.history()).some((h) => h.roomCode === 'pool-coast')).toBe(true)
  })

  it('相同房间不重复记历史，最多保留 50 条', async () => {
    const db = getDatabase()
    const template = db.rooms[0]
    for (let i = 0; i < 52; i++) {
      db.rooms.push({ ...template, roomId: `extra-${i}`, roomCode: `pool-extra-${i}` })
      await api.joinRoom(`pool-extra-${i}`)
    }
    await api.joinRoom('pool-extra-51')
    const history = await api.history()
    expect(history).toHaveLength(50)
    expect(new Set(history.map((h) => h.roomId)).size).toBe(50)
    expect(history[0].roomId).toBe('extra-51')
  })

  it('删除本人凭证后禁止读取，共享总结仍存在', async () => {
    await api.deleteHistory('room-memory')
    await expect(api.summary('room-memory')).rejects.toMatchObject({
      code: 'ROOM_HISTORY_REQUIRED',
    })
    expect(getDatabase().summaries['room-memory'].status).toBe('succeeded')
  })

  it('归档过期后隐藏历史，直接访问也会被拒绝', async () => {
    getDatabase().rooms.find((r) => r.roomId === 'room-memory')!.expiresAt = new Date(
      Date.now() - 1,
    ).toISOString()
    expect((await api.history()).some((h) => h.roomId === 'room-memory')).toBe(false)
    await expect(api.summary('room-memory')).rejects.toMatchObject({ code: 'ROOM_EXPIRED' })
  })

  it('并发触发同房总结只有一个有效生成，成功后重用正文', async () => {
    const first = generateText('summary', 'room-evening', () => {}, new AbortController().signal)
    await expect(
      generateText('summary', 'room-evening', () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SUMMARY_GENERATING' })
    await first
    const original = getDatabase().summaries['room-evening'].content
    let replay = ''
    await generateText(
      'summary',
      'room-evening',
      (text) => {
        replay = text
      },
      new AbortController().signal,
    )
    expect(replay).toBe(original)
    expect(getDatabase().summaries['room-evening'].status).toBe('succeeded')
  })

  it('模拟生成失败能恢复为可重试状态，不锁定成功', async () => {
    setScenario('ai-fail')
    await expect(
      generateText('summary', 'room-evening', () => {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' })
    expect(getDatabase().summaries['room-evening'].status).toBe('failed')
    setScenario('normal')
    await generateText('summary', 'room-evening', () => {}, new AbortController().signal)
    expect(getDatabase().summaries['room-evening'].status).toBe('succeeded')
  })
})

describe('房间页会话与清理', () => {
  it('普通成员不能修改房间设置或让其他成员下台', () => {
    const session = new MockRoomSession(getDatabase().rooms[0])
    sessions.push(session)
    expect(() =>
      session.settings({
        name: '修改房间',
        tag: '换个标签',
        maxMembers: 12,
        maxStageMembers: 4,
        isPasswordProtected: false,
      }),
    ).toThrow('只有房主')
    expect(() => session.leaveStage('mira')).toThrow('只有房主')
  })

  it('房主修改容量不能小于现有成员，设置可以保存', async () => {
    const room = await api.createRoom({
      name: '安静的海',
      tag: '一起听歌',
      maxMembers: 10,
      maxStageMembers: 4,
      protected: false,
    })
    vi.useFakeTimers()
    const session = new MockRoomSession(room)
    sessions.push(session)
    vi.advanceTimersByTime(2300)
    expect(() =>
      session.settings({
        name: '安静的海',
        tag: '一起听歌',
        maxMembers: 1,
        maxStageMembers: 1,
        isPasswordProtected: false,
      }),
    ).toThrow('人数不能小于')
    session.settings({
      name: '今晚的海',
      tag: '慢慢来',
      maxMembers: 8,
      maxStageMembers: 3,
      isPasswordProtected: true,
    })
    expect(getDatabase().rooms.find((r) => r.roomId === room.roomId)).toMatchObject({
      name: '今晚的海',
      maxMembers: 8,
      isPasswordProtected: true,
    })
  })

  it('房间歌单拖拽支持跨行移动并保存，不修改当前节目', () => {
    const session = new MockRoomSession(getDatabase().rooms[0])
    sessions.push(session)
    const states: RoomSnapshot[] = []
    session.subscribe((snapshot) => states.push(snapshot))
    const before = states.at(-1)!
    const first = before.myPlaylist[0]
    const target = before.myPlaylist.length - 1
    session.moveTrack(first, target)
    const after = states.at(-1)!
    expect(after.myPlaylist.at(-1)).toEqual(first)
    expect(after.myPlaylist.slice(0, target)).toEqual(before.myPlaylist.slice(1))
    expect(after.playback).toEqual(before.playback)
    expect(getDatabase().playlists[DEMO_EMAIL]).toEqual(after.myPlaylist)
    expect(() => session.moveTrack(first, -1)).toThrow('目标位置无效')
  })

  it('旧版本上报和普通听众上报不推进节目', () => {
    const session = new MockRoomSession(getDatabase().rooms[0])
    sessions.push(session)
    const states: RoomSnapshot[] = []
    session.subscribe((s) => states.push(s))
    const version = states.at(-1)!.playback.version
    session.mediaError(version - 1)
    session.mediaError(version)
    expect(states.at(-1)!.playback.version).toBe(version)
  })

  it('当前播放者有效上报可切歌，过期重复上报不推进', async () => {
    const room = await api.createRoom({
      name: '我的电台',
      tag: '一起听歌',
      maxMembers: 10,
      maxStageMembers: 4,
      protected: false,
    })
    const session = new MockRoomSession(room)
    sessions.push(session)
    const states: RoomSnapshot[] = []
    session.subscribe((s) => states.push(s))
    session.toggleStage()
    const version = states.at(-1)!.playback.version
    session.mediaError(version)
    expect(states.at(-1)!.playback.version).toBe(version + 1)
    session.mediaError(version)
    expect(states.at(-1)!.playback.version).toBe(version + 1)
  })

  it('房间歌单去重及容量控制独立于个人喜欢', () => {
    const session = new MockRoomSession(getDatabase().rooms[0])
    sessions.push(session)
    expect(() => session.addTrack(catalog[0])).toThrow('已经在')
    session.addTrack(catalog[20])
    expect(getDatabase().likes[DEMO_EMAIL]).toHaveLength(12)
  })

  it('聊天频率受限，离页后没有残留回复或轮播定时器', () => {
    vi.useFakeTimers()
    const session = new MockRoomSession(getDatabase().rooms[0])
    sessions.push(session)
    for (let i = 0; i < 5; i++) session.send(`消息 ${i}`)
    expect(() => session.send('第六条')).toThrow('发得有些快')
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    session.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => session.send('离页后发送')).toThrow('重新连接')
  })

  it('节目轮播不取消正在进行的重连恢复', () => {
    vi.useFakeTimers()
    const session = new MockRoomSession(getDatabase().rooms[0])
    sessions.push(session)
    const states: RoomSnapshot[] = []
    session.subscribe((s) => states.push(s))
    vi.advanceTimersByTime(24_000)
    session.reconnect()
    vi.advanceTimersByTime(1900)
    expect(states.at(-1)!.connection).toBe('joined')
  })

  it('房主结束房间后不会因退出清理重新激活', async () => {
    const room = await api.createRoom({
      name: '日落之后',
      tag: '安静听歌',
      maxMembers: 10,
      maxStageMembers: 4,
      protected: false,
    })
    vi.useFakeTimers()
    const session = new MockRoomSession(room)
    sessions.push(session)
    vi.advanceTimersByTime(2300)
    session.dissolve()
    expect(getDatabase().rooms.find((r) => r.roomId === room.roomId)!.status).toBe('ended')
    expect(vi.getTimerCount()).toBe(0)
  })
})
