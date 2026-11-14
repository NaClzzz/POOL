'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { createRoomSocket, sendRoomCommand, RoomCommandError } from '@/lib/socket-client'
import { useSession } from '@/stores/session'
import { usePlayer } from '@/stores/player'
import type { RoomCommands, RoomSnapshot } from '@/contracts/room'

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
  const socket = useRef<ReturnType<typeof createRoomSocket> | null>(null)
  const password = useRef('')
  const switchConfirmed = useRef(false)
  const router = useRouter(),
    client = useQueryClient()
  const userId = useSession((s) => s.user?.id)
  const [commandError, setCommandError] = useState('')
  const [notice, setNotice] = useState('')
  /** 接收本人完整快照，房间和版本必须仍匹配。 */
  const apply = useCallback(
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
  /** 首次加入和每次重连都获取完整快照，不恢复客户端猜测的队列。 */
  const join = useCallback(
    async (secret: string, switching = false) => {
      const connection = socket.current
      if (!connection?.connected) return
      password.current = secret
      if (switching) switchConfirmed.current = true
      store.setState({
        error: null,
        connection: store.getState().snapshot ? 'reconnecting' : 'joining',
      })
      const sent = Date.now()
      try {
        const result = await sendRoomCommand(
          connection,
          switchConfirmed.current ? 'room:switch' : 'room:join',
          {
            roomCode: code,
            ...(secret ? { password: secret } : {}),
          },
        )
        if (socket.current !== connection) return
        if (result.snapshot) {
          apply(result.snapshot, result.snapshot.serverTime - (sent + Date.now()) / 2, true)
          switchConfirmed.current = false
        }
        void client.invalidateQueries({ queryKey: ['room-history', userId] })
      } catch (error) {
        if (socket.current !== connection) return
        store.setState({ error: error as Error })
        if (
          error instanceof RoomCommandError &&
          error.code === 'ACK_TIMEOUT' &&
          connection.connected
        ) {
          const syncSent = Date.now()
          void sendRoomCommand(connection, 'room:sync', {})
            .then((result) => {
              if (socket.current !== connection || !result.snapshot) return
              apply(result.snapshot, result.snapshot.serverTime - (syncSent + Date.now()) / 2, true)
              switchConfirmed.current = false
              void client.invalidateQueries({ queryKey: ['room-history', userId] })
            })
            .catch(() => undefined)
        }
      }
    },
    [apply, client, code, store, userId],
  )
  useEffect(() => {
    if (!userId) return
    const connection = createRoomSocket()
    socket.current = connection
    connection.on('connect', () => void join(password.current))
    connection.on('disconnect', () => {
      store.setState({ connection: 'reconnecting' })
      usePlayer.getState().setRoom(false)
    })
    connection.on('connect_error', (error) => store.setState({ error }))
    connection.on('room:state', (incoming) => {
      const current = store.getState().snapshot
      if (
        incoming.room.roomCode !== code ||
        !current ||
        incoming.playback.version < current.playback.version ||
        incoming.revision < current.revision
      )
        return
      apply({ ...current, ...incoming })
    })
    connection.on('room:message', (message) => {
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
    })
    connection.on('user:room-playlist', (items) => {
      const current = store.getState().snapshot
      if (current) store.setState({ snapshot: { ...current, myPlaylist: items } })
    })
    connection.on('room:forced-leave', (event) => {
      if (event.roomCode && event.roomCode !== code) return
      connection.disconnect()
      password.current = ''
      switchConfirmed.current = false
      store.setState({ snapshot: null })
      usePlayer.getState().setRoom(false)
      void client.invalidateQueries({ queryKey: ['room-history', userId] })
      router.replace('/rooms')
    })
    connection.connect()
    return () => {
      socket.current = null
      if (connection.connected) connection.emit('room:leave', {}, () => undefined)
      connection.removeAllListeners()
      connection.disconnect()
      password.current = ''
      switchConfirmed.current = false
      store.setState({ snapshot: null, error: null, connection: 'joining' })
      usePlayer.getState().setRoom(false)
      void client.invalidateQueries({ queryKey: ['rooms', userId] })
      void client.invalidateQueries({ queryKey: ['room-history', userId] })
    }
  }, [apply, client, code, join, router, store, userId])
  /** 失败时保留表单草稿；确认超时只查询状态，不重发写操作。 */
  const command = useCallback(
    async <K extends keyof RoomCommands>(name: K, payload: RoomCommands[K]): Promise<boolean> => {
      const connection = socket.current
      if (!connection) return false
      try {
        const result = await sendRoomCommand(connection, name, payload)
        if (socket.current !== connection) return false
        if (result.snapshot) apply(result.snapshot)
        setCommandError('')
        if (result.imported)
          setNotice(
            `已加入 ${result.imported.added} 首，重复 ${result.imported.duplicates} 首，不支持或无时长 ${result.imported.failed} 首，容量不足 ${result.imported.capacitySkipped} 首`,
          )
        return true
      } catch (error) {
        if (socket.current !== connection) return false
        setCommandError((error as Error).message)
        if (
          error instanceof RoomCommandError &&
          error.code === 'ACK_TIMEOUT' &&
          connection.connected
        ) {
          void sendRoomCommand(connection, 'room:sync', {})
            .then((result) => {
              if (socket.current === connection && result.snapshot) apply(result.snapshot)
            })
            .catch(() => undefined)
        }
        return false
      }
    },
    [apply],
  )
  return { ...state, commandError, notice, command, join, leave: () => router.push('/rooms') }
}
