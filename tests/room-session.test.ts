// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomSnapshot } from '@/contracts/room'

const mocks = vi.hoisted(() => ({
  userId: 'a',
  setRoom: vi.fn(),
  send: vi.fn(),
  create: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
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
  it('断线停音，重连重新加入取快照，卸载移除监听及连接', async () => {
    await mount()
    const socket = sockets[0]
    await act(async () => socket.disconnect())
    expect(current.snapshot).toEqual(snapshot)
    expect(current.connection).toBe('reconnecting')
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
    expect(current.commandError).toBe('确认超时')
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
    await act(async () =>
      sockets[1].fire('room:forced-leave', { roomCode: 'code', reason: 'kicked' }),
    )
    expect(mocks.replace).toHaveBeenCalledWith('/rooms')
    expect(current.snapshot).toBe(null)
  })
})
