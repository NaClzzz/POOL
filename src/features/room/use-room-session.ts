'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { createRoomSocket, sendRoomCommand, RoomCommandError } from '@/lib/socket-client'
import { useSession } from '@/stores/session'
import { usePlayer } from '@/stores/player'
import { notifyError, notifySuccess } from '@/lib/notifications'
import type {
  RoomCommands,
  RoomPlaylistItem,
  RoomSnapshot,
  ServerRoomEvents,
} from '@/contracts/room'

/** 页面作用域实时状态，不持久化且不进入 Query 缓存。 */
type SessionState = {
  snapshot: RoomSnapshot | null
  connection: 'joining' | 'joined' | 'reconnecting'
  error: Error | null
  clockOffset: number
}

/** 有独立操作结果的 Socket 命令文案；聊天、同步和自动媒体报告不弹成功通知。 */
const commandSuccess: Partial<Record<keyof RoomCommands, string>> = {
  'room:stage:join': '已上台',
  'room:stage:leave': '上台成员已更新',
  'room:playback:skip': '已切歌',
  'room:playback:vote-skip': '已投票切歌',
  'room:update-settings': '房间设置已保存',
  'room:kick-member': '已移出成员',
}

const initialState: SessionState = {
  snapshot: null,
  connection: 'joining',
  error: null,
  clockOffset: 0,
}

/** 房间连接生命周期、广播投影和命令错误集中于单个 hook。 */
export function useRoomSession(code: string) {
  const [state, setState] = useState<SessionState>(initialState)
  const snapshotRef = useRef<RoomSnapshot | null>(null)
  const socketRef = useRef<ReturnType<typeof createRoomSocket> | null>(null)
  const passwordRef = useRef('')
  const switchConfirmed = useRef(false)
  const router = useRouter()
  const client = useQueryClient()
  const userId = useSession((s) => s.user?.id)

  /** 统一检查完整快照的房间、播放版本和修订号；重新加入允许接收重建状态。 */
  const applySnapshot = useCallback(
    (snapshot: RoomSnapshot, offset?: number, freshJoin = false) => {
      if (snapshot.room.roomCode !== code) return
      const old = snapshotRef.current
      if (
        !freshJoin &&
        old &&
        (old.playback.version > snapshot.playback.version || old.revision > snapshot.revision)
      )
        return
      snapshotRef.current = snapshot
      setState((prev) => ({
        snapshot,
        connection: 'joined',
        error: null,
        clockOffset: offset === undefined ? prev.clockOffset : offset,
      }))
      usePlayer.getState().setRoom(true)
    },
    [code],
  )

  /** HTTP 歌单写操作完成后立即更新本地快照，并通知 Socket 广播和唤醒轮播。 */
  const updatePlaylist = useCallback((items: RoomPlaylistItem[]) => {
    const current = snapshotRef.current
    if (!current) return
    const next = { ...current, myPlaylist: items }
    snapshotRef.current = next
    setState((prev) => (prev.snapshot ? { ...prev, snapshot: next } : prev))
  }, [])

  /** 确认超时只同步状态；加入恢复额外校准时间并刷新历史，不重放原命令。 */
  const syncRoom = useCallback(
    (socket: ReturnType<typeof createRoomSocket>, freshJoin = false) => {
      const sent = Date.now()
      return sendRoomCommand(socket, 'room:sync', {})
        .then((result) => {
          if (socketRef.current !== socket || !result.snapshot) return
          const offset = freshJoin
            ? result.snapshot.serverTime - (sent + Date.now()) / 2
            : undefined
          applySnapshot(result.snapshot, offset, freshJoin)
          if (freshJoin) {
            switchConfirmed.current = false
            void client.invalidateQueries({ queryKey: ['room-history', userId] })
          }
        })
        .catch(() => undefined)
    },
    [applySnapshot, client, userId],
  )

  /** 首次加入和每次重连都获取完整快照，不恢复客户端猜测的队列。 */
  const join = useCallback(
    async (password: string, switching = false) => {
      const socket = socketRef.current
      if (!socket?.connected) return
      passwordRef.current = password
      if (switching) switchConfirmed.current = true
      setState((prev) => ({
        ...prev,
        error: null,
        connection: snapshotRef.current ? 'reconnecting' : 'joining',
      }))
      const sent = Date.now()
      try {
        const result = await sendRoomCommand(
          socket,
          switchConfirmed.current ? 'room:switch' : 'room:join',
          {
            roomCode: code,
            ...(password ? { password } : {}),
          },
        )
        if (socketRef.current !== socket) return
        if (result.snapshot) {
          applySnapshot(result.snapshot, result.snapshot.serverTime - (sent + Date.now()) / 2, true)
          switchConfirmed.current = false
        }
        void client.invalidateQueries({ queryKey: ['room-history', userId] })
      } catch (error) {
        if (socketRef.current !== socket) return
        setState((prev) => ({ ...prev, error: error as Error }))
        if (error instanceof RoomCommandError && error.code === 'ACK_TIMEOUT' && socket.connected) {
          void syncRoom(socket, true)
        }
      }
    },
    [applySnapshot, client, code, syncRoom, userId],
  )

  useEffect(() => {
    if (!userId) return
    const socket = createRoomSocket()
    socketRef.current = socket

    /** 建连后重新加入，复用已确认的密码和切房意图。 */
    const handleConnect = () => void join(passwordRef.current)
    /** 暂时断线保留快照，停止房间音频并等待当前页面内重连。 */
    const handleDisconnect = () => {
      setState((prev) => ({ ...prev, connection: 'reconnecting' }))
      usePlayer.getState().setRoom(false)
    }
    /** 连接错误沿用会话错误展示。 */
    const handleConnectError = (error: Error) => setState((prev) => ({ ...prev, error }))
    /** 公共状态只能合并进已有完整快照，保留本人歌单和独立维护的聊天。 */
    const handleRoomState: ServerRoomEvents['room:state'] = (incoming) => {
      const current = snapshotRef.current
      if (!current) return
      applySnapshot({ ...current, ...incoming })
    }
    /** 消息按房间身份接收并以消息 ID 去重，只保留最近两百条。 */
    const handleMessage: ServerRoomEvents['room:message'] = (message) => {
      const current = snapshotRef.current
      if (
        !current ||
        message.roomId !== current.room.roomId ||
        current.messages.some((m) => m.id === message.id)
      )
        return
      const next = { ...current, messages: [...current.messages, message].slice(-200) }
      snapshotRef.current = next
      setState((prev) => (prev.snapshot ? { ...prev, snapshot: next } : prev))
    }
    /** 私有歌单事件独立更新，不覆盖房间公共状态和消息。 */
    const handlePlaylist: ServerRoomEvents['user:room-playlist'] = (items) => updatePlaylist(items)
    /** 当前房间强退时清理凭据、停止播放并返回大厅。 */
    const handleForcedLeave: ServerRoomEvents['room:forced-leave'] = (payload) => {
      if (payload.roomCode && payload.roomCode !== code) return
      socket.disconnect()
      passwordRef.current = ''
      switchConfirmed.current = false
      snapshotRef.current = null
      setState((prev) => ({ ...prev, snapshot: null }))
      usePlayer.getState().setRoom(false)
      void client.invalidateQueries({ queryKey: ['room-history', userId] })
      if (payload.reason === 'dissolved') notifySuccess('房间已结束')
      else if (payload.reason === 'switched') notifySuccess('已切换到其他房间')
      else
        notifyError(
          new Error(payload.reason === 'kicked' ? '你已被移出房间' : '登录已失效，请重新登录'),
        )
      router.replace('/rooms')
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('connect_error', handleConnectError)
    socket.on('room:state', handleRoomState)
    socket.on('room:message', handleMessage)
    socket.on('user:room-playlist', handlePlaylist)
    socket.on('room:forced-leave', handleForcedLeave)
    socket.connect()

    return () => {
      socketRef.current = null
      if (socket.connected) socket.emit('room:leave', {}, () => undefined)
      socket.removeAllListeners()
      socket.disconnect()
      passwordRef.current = ''
      switchConfirmed.current = false
      snapshotRef.current = null
      setState(initialState)
      usePlayer.getState().setRoom(false)
      void client.invalidateQueries({ queryKey: ['rooms', userId] })
      void client.invalidateQueries({ queryKey: ['room-history', userId] })
    }
  }, [applySnapshot, client, code, join, router, updatePlaylist, userId])

  /** 失败时保留表单草稿；确认超时只查询状态，不重发写操作。 */
  const command = useCallback(
    async <K extends keyof RoomCommands>(
      eventName: K,
      payload: RoomCommands[K],
      onValidationError?: (error: Error) => void,
    ): Promise<boolean> => {
      const socket = socketRef.current
      if (!socket) return false
      try {
        const result = await sendRoomCommand(socket, eventName, payload)
        if (socketRef.current !== socket) return false
        if (result.snapshot) applySnapshot(result.snapshot)
        if (commandSuccess[eventName]) notifySuccess(commandSuccess[eventName])
        return true
      } catch (error) {
        if (socketRef.current !== socket) return false
        if (
          onValidationError &&
          error instanceof RoomCommandError &&
          (error.code === 'INVALID_INPUT' || error.code === 'ROOM_CAPACITY_CONFLICT')
        ) {
          onValidationError(error)
          return false
        }
        if (
          eventName !== 'room:playback:media-error' &&
          eventName !== 'room:playlist:sync' &&
          !(error instanceof RoomCommandError && error.code === 'NOT_CONNECTED')
        )
          notifyError(error as Error)
        if (error instanceof RoomCommandError && error.code === 'ACK_TIMEOUT' && socket.connected) {
          void syncRoom(socket)
        }
        return false
      }
    },
    [applySnapshot, syncRoom],
  )

  return {
    ...state,
    command,
    join,
    updatePlaylist,
    leave: () => router.push('/rooms'),
  }
}
