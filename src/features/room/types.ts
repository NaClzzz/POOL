import type { RoomCommands } from '@/contracts/room'

/** 子组件只提交命令，不直接持有 Socket。 */
export type RoomCommand = <K extends keyof RoomCommands>(
  name: K,
  payload: RoomCommands[K],
) => Promise<boolean>
