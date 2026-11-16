'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { createRoomSocket, sendRoomCommand, RoomCommandError } from '@/lib/socket-client'
import { useSession } from '@/stores/session'
import { usePlayer } from '@/stores/player'
import type { RoomCommands, RoomSnapshot, ServerRoomEvents } from '@/contracts/room'

/** 页面作用域实时状态，不持久化且不进入 Query 缓存。 */
type SessionState = {
  snapshot: RoomSnapshot | null
  connection: 'joining' | 'joined' | 'reconnecting'
  error: Error | null
  clockOffset: number
}

/** 房间连接生命周期、广播投影和命令错误集中于单个 hook。 */
export function useRoomSession(code: string) {
  const [store] = useState(() =>
    createStore<SessionState>(() => ({
      snapshot: null,
      connection: 'joining',
      error: null,
      clockOffset: 0,
    })),
  )

  const state = useStore(store)
  const socketRef = useRef<ReturnType<typeof createRoomSocket> | null>(null)
  const passwordRef = useRef('')
  const switchConfirmed = useRef(false)
  const router = useRouter()
  const client = useQueryClient()
  const userId = useSession((s) => s.user?.id)
  const [commandError, setCommandError] = useState('')
  const [notice, setNotice] = useState('')

  /** 统一检查完整快照的房间、播放版本和修订号；重新加入允许接收重建状态。 */
  const applySnapshot = useCallback(
    (snapshot: RoomSnapshot, offset?: number, freshJoin = false) => {
      if (snapshot.room.roomCode !== code) return
      const old = store.getState().snapshot
      if (
        !freshJoin &&
        old &&
        (old.playback.version > snapshot.playback.version || old.revision > snapshot.revision)
      )
        return
      store.setState({
        snapshot,
        connection: 'joined',
        error: null,
        ...(offset === undefined ? {} : { clockOffset: offset }),
      })
      usePlayer.getState().setRoom(true)
    },
    [code, store],
  )

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
      store.setState({
        error: null,
        connection: store.getState().snapshot ? 'reconnecting' : 'joining',
      })
      const sent = Date.now()
      try {
        // 发送 join 请求
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
        store.setState({ error: error as Error })
        if (error instanceof RoomCommandError && error.code === 'ACK_TIMEOUT' && socket.connected) {
          void syncRoom(socket, true)
        }
      }
    },
    [applySnapshot, client, code, store, syncRoom, userId],
  )

  useEffect(() => {
    if (!userId) return
    // 建立连接，得到 Socket 实例
    const socket = createRoomSocket()
    socketRef.current = socket

    // 注册 socket 事件函数
    /** 建连后重新加入，复用已确认的密码和切房意图。 */
    const handleConnect = () => void join(passwordRef.current)
    /** 暂时断线保留快照，停止房间音频并等待当前页面内重连。 */
    const handleDisconnect = () => {
      store.setState({ connection: 'reconnecting' })
      usePlayer.getState().setRoom(false)
    }
    /** 连接错误沿用会话错误展示。 */
    const handleConnectError = (error: Error) => store.setState({ error })
    /** 公共状态只能合并进已有完整快照，保留本人歌单和独立维护的聊天。 */
    const handleRoomState: ServerRoomEvents['room:state'] = (incoming) => {
      const current = store.getState().snapshot
      if (!current) return
      applySnapshot({ ...current, ...incoming })
    }
    /** 消息按房间身份接收并以消息 ID 去重，只保留最近两百条。 */
    const handleMessage: ServerRoomEvents['room:message'] = (message) => {
      const current = store.getState().snapshot
      if (
        !current ||
        message.roomId !== current.room.roomId ||
        current.messages.some((m) => m.id === message.id)
      )
        return
      store.setState({
        snapshot: { ...current, messages: [...current.messages, message].slice(-200) },
      })
    }
    /** 私有歌单事件独立更新，不覆盖房间公共状态和消息。 */
    const handlePlaylist: ServerRoomEvents['user:room-playlist'] = (items) => {
      const current = store.getState().snapshot
      if (current) store.setState({ snapshot: { ...current, myPlaylist: items } })
    }
    /** 当前房间强退时清理凭据、停止播放并返回大厅。 */
    const handleForcedLeave: ServerRoomEvents['room:forced-leave'] = (payload) => {
      if (payload.roomCode && payload.roomCode !== code) return
      socket.disconnect()
      passwordRef.current = ''
      switchConfirmed.current = false
      store.setState({ snapshot: null })
      usePlayer.getState().setRoom(false)
      void client.invalidateQueries({ queryKey: ['room-history', userId] })
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
      store.setState({ snapshot: null, error: null, connection: 'joining' })
      usePlayer.getState().setRoom(false)
      void client.invalidateQueries({ queryKey: ['rooms', userId] })
      void client.invalidateQueries({ queryKey: ['room-history', userId] })
    }
  }, [applySnapshot, client, code, join, router, store, userId])

  /** 失败时保留表单草稿；确认超时只查询状态，不重发写操作。 */
  const command = useCallback(
    async <K extends keyof RoomCommands>(
      eventName: K,
      payload: RoomCommands[K],
    ): Promise<boolean> => {
      const socket = socketRef.current
      if (!socket) return false
      try {
        const result = await sendRoomCommand(socket, eventName, payload)
        if (socketRef.current !== socket) return false
        if (result.snapshot) applySnapshot(result.snapshot)
        setCommandError('')
        if (result.imported)
          setNotice(
            `已加入 ${result.imported.added} 首，重复 ${result.imported.duplicates} 首，不支持或无时长 ${result.imported.failed} 首，容量不足 ${result.imported.capacitySkipped} 首`,
          )
        return true
      } catch (error) {
        if (socketRef.current !== socket) return false
        setCommandError((error as Error).message)
        if (error instanceof RoomCommandError && error.code === 'ACK_TIMEOUT' && socket.connected) {
          void syncRoom(socket)
        }
        return false
      }
    },
    [applySnapshot, syncRoom],
  )
  return { ...state, commandError, notice, command, join, leave: () => router.push('/rooms') }
}
