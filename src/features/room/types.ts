import type { RoomCommands } from '@/contracts/room'

/** 子组件只提交命令；表单可接收校验错误，不直接持有 Socket。 */
export type RoomCommand = <K extends keyof RoomCommands>(
  name: K,
  payload: RoomCommands[K],
  onValidationError?: (error: Error) => void,
) => Promise<boolean>
