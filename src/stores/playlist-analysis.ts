import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 每个账号只保留最近一次完整分析；生成状态、错误和半成品不持久化。 */
type PlaylistAnalysisStore = {
  results: Record<string, string>
  save: (userId: string, content: string) => void
}

/** 歌单分析仅保存在当前浏览器，刷新后恢复，不作为服务端业务资料。 */
export const usePlaylistAnalysis = create<PlaylistAnalysisStore>()(
  persist(
    (set) => ({
      results: {},
      /** 完整生成后替换当前账号的结果，其他账号的结果保持独立。 */
      save: (userId, content) => set((s) => ({ results: { ...s.results, [userId]: content } })),
    }),
    {
      name: 'pool:playlist-analysis:v1',
      partialize: ({ results }) => ({ results }),
      skipHydration: true,
    },
  ),
)
