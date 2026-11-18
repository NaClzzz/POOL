// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomSnapshot } from '@/contracts/room'
import { catalog } from './fixtures/tracks'

const mocks = vi.hoisted(() => ({
  userId: 'a',
  setRoom: vi.fn(),
  send: vi.fn(),
  create: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}))
vi.mock('@/lib/notifications', () => ({
  notifySuccess: mocks.notifySuccess,
  notifyError: mocks.notifyError,
}))
vi.mock('@/lib/socket-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/socket-client')>()),
  createRoomSocket: mocks.create,
  sendRoomCommand: mocks.send,
}))
vi.mock('@/stores/session', () => ({
  useSession: (select: (state: { user: { id: string } }) => unknown) =>
    select({ user: { id: mocks.userId } }),
}))
vi.mock('@/stores/player', () => ({ usePlayer: { getState: () => ({ setRoom: mocks.setRoom }) } }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
const router = { replace: mocks.replace, push: mocks.push }
import { RoomCommandError } from '@/lib/socket-client'
import { useRoomSession } from '@/features/room/use-room-session'

/** 测试传输只模拟事件，hook 内真实运行 Zustand、Query 和 React 生命周期。 */
class SocketFixture {
  connected = false
  handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  emit = vi.fn()
  on(name: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler])
    return this
  }
  fire(name: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(name) ?? []) handler(...args)
  }
  connect() {
    this.connected = true
    this.fire('connect')
  }
  disconnect() {
    this.connected = false
    this.fire('disconnect')
  }
  removeAllListeners() {
    this.handlers.clear()
  }
}
let root: Root, host: HTMLDivElement, query: QueryClient, current: ReturnType<typeof useRoomSession>
let sockets: SocketFixture[]
const snapshot: RoomSnapshot = {
  room: {
    roomId: 'r',
    roomCode: 'code',
    name: '房间',
    tag: '标签',
    ownerId: 'a',
    ownerName: 'A',
    createdBy: 'a',
    memberCount: 1,
    maxMembers: 12,
    maxStageMembers: 4,
    isPasswordProtected: false,
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    endedAt: null,
    expiresAt: null,
  },
  members: [
    { userId: 'a', name: 'A', image: null, joinedAt: new Date().toISOString(), isOwner: true },
  ],
  stageIds: [],
  messages: [],
  myPlaylist: [],
  playback: {
    roomId: 'r',
    roomCode: 'code',
    version: 1,
    status: 'idle',
    activeMemberId: null,
    currentItemId: null,
    startedAt: null,
    startOffsetMs: 0,
    durationMs: null,
    track: null,
    votes: [],
    skipVoteRequired: 0,
  },
  serverTime: Date.now(),
  revision: 1,
}
/** 公共广播没有本人歌单或消息，不能用于构造首次加入快照。 */
const publicState = {
  room: snapshot.room,
  members: snapshot.members,
  stageIds: snapshot.stageIds,
  playback: snapshot.playback,
  serverTime: snapshot.serverTime,
  revision: snapshot.revision,
}
/** 捕获 hook 结果只在 effect 中进行，不在 render 写外部变量。 */
function Probe() {
  const result = useRoomSession('code')
  useEffect(() => {
    current = result
  })
  return null
}
/** 挂载带真实 QueryClient 的房间会话。 */
async function mount() {
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client: query }, createElement(Probe))),
  )
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  mocks.userId = 'a'
  sockets = []
  mocks.create.mockImplementation(() => {
    const socket = new SocketFixture()
    sockets.push(socket)
    return socket
  })
  mocks.send.mockResolvedValue({ snapshot })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  query.clear()
  host.remove()
  vi.restoreAllMocks()
})
describe('房间会话生命周期', () => {
  it('加入后接收状态和消息，拒绝其他房间及旧节目，消息 ID 去重', async () => {
    await mount()
    expect(current.connection).toBe('joined')
    expect(mocks.setRoom).toHaveBeenCalledWith(true)
    const socket = sockets[0]
    await act(async () =>
      socket.fire('room:state', { ...snapshot, playback: { ...snapshot.playback, version: 2 } }),
    )
    await act(async () => socket.fire('room:state', snapshot))
    expect(current.snapshot?.playback.version).toBe(2)
    const message = {
      id: 'm',
      roomId: 'r',
      senderId: 'a',
      senderName: 'A',
      content: '你好',
      createdAt: new Date().toISOString(),
    }
    await act(async () => {
      socket.fire('room:message', message)
      socket.fire('room:message', message)
      socket.fire('room:message', { ...message, id: 'other', roomId: 'other' })
    })
    expect(current.snapshot?.messages.length).toBe(1)
  })
  it('公共广播不建立首次快照，合并后保留私有数据且重渲染不重新连接', async () => {
    let finish!: (value: { snapshot: RoomSnapshot }) => void
    mocks.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await mount()
    const socket = sockets[0]
    await act(async () => socket.fire('room:state', publicState))
    expect(current.snapshot).toBeNull()
    expect(mocks.setRoom).not.toHaveBeenCalledWith(true)
    await act(async () => finish({ snapshot }))
    const playlist = [{ itemId: 'item', position: 0, track: catalog[0] }]
    const message = {
      id: 'm',
      roomId: 'r',
      senderId: 'a',
      senderName: 'A',
      content: '你好',
      createdAt: new Date().toISOString(),
    }
    await act(async () => {
      socket.fire('user:room-playlist', playlist)
      socket.fire('room:message', message)
      socket.fire('room:state', {
        ...publicState,
        room: { ...snapshot.room, name: '最新名称' },
        playback: { ...snapshot.playback, version: 2 },
        revision: 2,
      })
      socket.fire('room:state', {
        ...publicState,
        room: { ...snapshot.room, roomCode: 'other' },
        revision: 100,
      })
      socket.fire('room:state', { ...publicState, revision: 3 })
      socket.fire('room:state', {
        ...publicState,
        playback: { ...snapshot.playback, version: 3 },
        revision: 1,
      })
    })
    expect(current.snapshot?.room.name).toBe('最新名称')
    expect(current.snapshot?.playback.version).toBe(2)
    expect(current.snapshot?.revision).toBe(2)
    expect(current.snapshot?.myPlaylist).toEqual(playlist)
    expect(current.snapshot?.messages).toEqual([message])
    await mount()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect([...socket.handlers.values()].every((handlers) => handlers.length === 1)).toBe(true)
  })
  it('加入超时同步校准时间并接受重建状态，清除切房意图并刷新历史', async () => {
    await mount()
    await act(async () => sockets[0].fire('room:state', { ...publicState, revision: 100 }))
    const invalidate = vi.spyOn(query, 'invalidateQueries')
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    mocks.send.mockRejectedValueOnce(new RoomCommandError('ACK_TIMEOUT', '确认超时'))
    mocks.send.mockResolvedValueOnce({ snapshot: { ...snapshot, serverTime: 105_000 } })
    await act(async () => current.join('password', true))
    expect(current.snapshot?.revision).toBe(1)
    expect(current.clockOffset).toBe(5000)
    expect(current.error).toBeNull()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room-history', 'a'] })
    expect(mocks.send.mock.calls.filter((call) => call[1] === 'room:switch')).toHaveLength(1)
    expect(mocks.send.mock.calls.filter((call) => call[1] === 'room:sync')).toHaveLength(1)
    await act(async () => current.join('password'))
    expect(mocks.send.mock.calls.at(-1)?.[1]).toBe('room:join')
    expect(sockets).toHaveLength(1)
  })
  it('普通命令超时同步拒绝旧状态，不重新校时或刷新历史', async () => {
    await mount()
    const originalOffset = current.clockOffset
    const invalidate = vi.spyOn(query, 'invalidateQueries')
    await act(async () => sockets[0].fire('room:state', { ...publicState, revision: 100 }))
    mocks.send.mockRejectedValueOnce(new RoomCommandError('ACK_TIMEOUT', '确认超时'))
    mocks.send.mockResolvedValueOnce({ snapshot: { ...snapshot, serverTime: 1 } })
    await act(async () => current.command('room:playlist:clear', {}))
    expect(current.snapshot?.revision).toBe(100)
    expect(current.clockOffset).toBe(originalOffset)
    expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: '确认超时' }),
    )
    expect(invalidate).not.toHaveBeenCalled()
    expect(mocks.send.mock.calls.filter((call) => call[1] === 'room:playlist:clear')).toHaveLength(
      1,
    )
    expect(mocks.send.mock.calls.filter((call) => call[1] === 'room:sync')).toHaveLength(1)
  })
  it.each(['join', 'command'] as const)(
    '%s 超时后的同步失败保留原错误且不循环重试',
    async (kind) => {
      await mount()
      mocks.send.mockClear()
      mocks.send.mockRejectedValueOnce(new RoomCommandError('ACK_TIMEOUT', '确认超时'))
      mocks.send.mockRejectedValueOnce(new RoomCommandError('NOT_IN_ROOM', '同步失败'))
      await act(async () => {
        if (kind === 'join') await current.join('')
        else await current.command('room:chat:send', { content: 'hello' })
      })
      if (kind === 'join') {
        expect(current.error?.message).toBe('确认超时')
        expect(mocks.notifyError).not.toHaveBeenCalled()
      } else {
        expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: '确认超时' }),
        )
      }
      expect(mocks.send.mock.calls.map((call) => call[1])).toEqual([
        kind === 'join' ? 'room:join' : 'room:chat:send',
        'room:sync',
      ])
    },
  )
  it.each(['join', 'command'] as const)('%s 超时后的同步忽略换号前连接的晚到结果', async (kind) => {
    await mount()
    mocks.send.mockRejectedValueOnce(new RoomCommandError('ACK_TIMEOUT', '确认超时'))
    let finish!: (value: { snapshot: RoomSnapshot }) => void
    mocks.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await act(async () => {
      if (kind === 'join') await current.join('')
      else await current.command('room:chat:send', { content: 'hello' })
    })
    mocks.userId = 'b'
    await mount()
    const latest = current.snapshot
    const invalidate = vi.spyOn(query, 'invalidateQueries')
    mocks.setRoom.mockClear()
    await act(async () => finish({ snapshot: { ...snapshot, revision: 999 } }))
    expect(current.snapshot).toBe(latest)
    expect(invalidate).not.toHaveBeenCalled()
    expect(mocks.setRoom).not.toHaveBeenCalledWith(true)
    expect(sockets).toHaveLength(2)
  })
  it('断线停音，重连重新加入取快照，卸载移除监听及连接', async () => {
    await mount()
    const socket = sockets[0]
    await act(async () => socket.disconnect())
    expect(current.snapshot).toEqual(snapshot)
    expect(current.connection).toBe('reconnecting')
    expect(mocks.notifyError).not.toHaveBeenCalled()
    expect(mocks.setRoom).toHaveBeenLastCalledWith(false)
    await act(async () => socket.connect())
    expect(mocks.send.mock.calls.filter((call) => call[1] === 'room:join')).toHaveLength(2)
    await act(async () => root.unmount())
    expect(socket.handlers.size).toBe(0)
    expect(socket.connected).toBe(false)
    expect(socket.emit).toHaveBeenCalledWith('room:leave', {}, expect.any(Function))
    root = createRoot(host)
  })
  it('拒绝同节目旧投影，服务重启后的重新加入接受新进程快照', async () => {
    await mount()
    const socket = sockets[0]
    const newer = { ...snapshot, revision: 100, room: { ...snapshot.room, name: '最新名称' } }
    await act(async () => socket.fire('room:state', newer))
    await act(async () => socket.fire('room:state', snapshot))
    expect(current.snapshot?.room.name).toBe('最新名称')
    mocks.send.mockResolvedValueOnce({ snapshot })
    await act(async () => {
      await current.command('room:sync', {})
    })
    expect(current.snapshot?.room.name).toBe('最新名称')
    await act(async () => socket.disconnect())
    const restarted = { ...snapshot, playback: { ...snapshot.playback, version: 2 }, revision: 1 }
    mocks.send.mockResolvedValueOnce({ snapshot: restarted })
    await act(async () => socket.connect())
    expect(current.snapshot).toEqual(restarted)
  })
  it('首次加入确认丢失后查询当前快照，不重复加入', async () => {
    mocks.send.mockRejectedValueOnce(new RoomCommandError('ACK_TIMEOUT', '确认超时'))
    await mount()
    expect(current.connection).toBe('joined')
    expect(mocks.send.mock.calls.filter((call) => call[1] === 'room:join')).toHaveLength(1)
    expect(mocks.send.mock.calls.filter((call) => call[1] === 'room:sync')).toHaveLength(1)
  })
  it('切换已确认后补填密码保留切换意图，不重复要求确认', async () => {
    await mount()
    mocks.send.mockRejectedValueOnce(new RoomCommandError('ROOM_PASSWORD_REQUIRED', '请输入密码'))
    await act(async () => current.join('', true))
    await act(async () => current.join('correct-password'))
    expect(mocks.send.mock.calls.at(-1)?.[1]).toBe('room:switch')
    expect(mocks.send.mock.calls.at(-1)?.[2]).toEqual({
      roomCode: 'code',
      password: 'correct-password',
    })
  })
  it('写命令超时只拉快照，不重放命令', async () => {
    await mount()
    mocks.send.mockRejectedValueOnce(new RoomCommandError('ACK_TIMEOUT', '确认超时'))
    await act(async () => {
      expect(await current.command('room:chat:send', { content: 'hello' })).toBe(false)
    })
    expect(mocks.send.mock.calls.filter((call) => call[1] === 'room:chat:send')).toHaveLength(1)
    expect(mocks.send.mock.calls.filter((call) => call[1] === 'room:sync')).toHaveLength(1)
    expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: '确认超时' }),
    )
  })
  it('加入尚未完成就离页时忽略晚到结果，不重开播放器', async () => {
    let resolve!: (value: unknown) => void
    mocks.send.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    await mount()
    await act(async () => root.unmount())
    mocks.setRoom.mockClear()
    await act(async () => resolve({ snapshot }))
    expect(mocks.setRoom).not.toHaveBeenCalledWith(true)
    root = createRoot(host)
  })
  it('账号变化销毁旧连接，强退只处理当前房间', async () => {
    await mount()
    const old = sockets[0]
    mocks.userId = 'b'
    await mount()
    expect(old.connected).toBe(false)
    expect(old.handlers.size).toBe(0)
    expect(sockets).toHaveLength(2)
    await act(async () =>
      sockets[1].fire('room:forced-leave', { roomCode: 'other', reason: 'kicked' }),
    )
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.notifyError).not.toHaveBeenCalled()
    await act(async () =>
      sockets[1].fire('room:forced-leave', { roomCode: 'code', reason: 'kicked' }),
    )
    expect(mocks.replace).toHaveBeenCalledWith('/rooms')
    expect(current.snapshot).toBe(null)
    expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: '你已被移出房间' }),
    )
  })
  it('命令结果通知一次，聊天和同步成功保持静默，导入保留统计', async () => {
    await mount()
    await act(async () => current.command('room:playlist:clear', {}))
    expect(mocks.notifySuccess).toHaveBeenCalledExactlyOnceWith('房间歌单已清空')
    mocks.notifySuccess.mockClear()
    await act(async () => current.command('room:chat:send', { content: 'hello' }))
    await act(async () => current.command('room:sync', {}))
    expect(mocks.notifySuccess).not.toHaveBeenCalled()
    mocks.send.mockResolvedValueOnce({
      imported: { added: 2, duplicates: 3, failed: 4, capacitySkipped: 5 },
    })
    await act(async () => current.command('room:playlist:import-liked', {}))
    expect(mocks.notifySuccess).toHaveBeenCalledExactlyOnceWith(
      '已加入 2 首歌曲',
      '重复 3 首 · 不支持或无时长 4 首 · 容量不足 5 首',
    )
  })
  it('换号后旧命令失败不弹通知，断线错误保留连接状态', async () => {
    await mount()
    let fail!: (error: Error) => void
    mocks.send.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    )
    const pending = current.command('room:playlist:clear', {})
    mocks.userId = 'b'
    await mount()
    await act(async () => {
      fail(new RoomCommandError('FORBIDDEN', '旧操作失败'))
      await pending
    })
    expect(mocks.notifyError).not.toHaveBeenCalled()
    mocks.send.mockRejectedValueOnce(new RoomCommandError('NOT_CONNECTED', '连接已断开'))
    await act(async () => current.command('room:playlist:clear', {}))
    expect(mocks.notifyError).not.toHaveBeenCalled()
  })
  it('房间设置的服务端校验错误交回表单，不重复弹通知', async () => {
    await mount()
    const invalid = new RoomCommandError('ROOM_CAPACITY_CONFLICT', '人数上限不能小于当前人数')
    mocks.send.mockRejectedValueOnce(invalid)
    const showFieldError = vi.fn()
    await act(async () =>
      current.command(
        'room:update-settings',
        {
          name: '房间',
          tag: '标签',
          maxMembers: 2,
          maxStageMembers: 1,
          passwordAction: 'keep',
        },
        showFieldError,
      ),
    )
    expect(showFieldError).toHaveBeenCalledExactlyOnceWith(invalid)
    expect(mocks.notifyError).not.toHaveBeenCalled()
    expect(mocks.notifySuccess).not.toHaveBeenCalled()
  })
})
