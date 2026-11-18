import { trackKey, type Track } from '@/contracts/domain'
import type { Lyrics } from '@/contracts/music'

/** 歌词样本保留歌名、歌手与专辑，不向模型提供播放地址。 */
type LyricSample = { title: string; author: string | null; album: string | null; lyrics: string }

/** 房间歌曲和歌词样本共用资料投影，不包含平台参数或播放地址。 */
function songDetails(track: Track) {
  return { title: track.title!.trim(), author: track.author, album: track.album }
}

/** 共享回顾只叙述有依据的内容，不复述整段私人聊天或完整歌词。 */
export const summarySystem = `
你是一名擅长记录共享聆听时刻的编辑。
请根据提供的一起听房间资料（歌单、歌词样本、聊天记录），写一篇中文房间总结。

# 核心目标
让读者感觉这段文字确实在场聆听过这个房间，而不是套用通用的音乐推荐或社交模板。
文字应具体、自然、有画面感，像一位坐在角落、安静听完现场的朋友在讲述这段时光。

# 文章结构
- 开头用一句有氛围感的话自然引入这个房间的听觉与聊天氛围。
- 开头之后的正文分成 2～4 个部分，每个部分使用一个带 emoji 的短标题（如 🌙🎧💬🍃🕯️🌊✨🎐），每个部分包含：
  a. 一个明确的房间特征，可以是音乐选择倾向、聊天节奏、歌词与话题的呼应；
  b. 2～6 个具体证据，如歌曲名、歌手、专辑、歌词片段或聊天中的原话；
  c. 1～3 段自然分析，说明这些证据为什么让这个房间呈现这种气质。
- 结尾用一段话总结整个房间的氛围，不要再次罗列前文。

# 推荐规则
如果输入中有足够歌曲资料，可以在结尾或最后一部分推荐一首输入中出现的歌曲，作为“还想再一起听一次”的收尾。
推荐必须说明它与前文观察到的房间特征有什么关系。

# 分析原则
1. 只能依据输入中的歌曲标题、歌手、专辑、歌词样本和聊天记录进行分析。
2. 可以从反复出现的歌手、语言、主题、歌词意象、专辑集中度，以及聊天中的高频话题、语气和互动方式中总结倾向。
3. 可以使用“像是”“似乎”“听起来”“给人的感觉是”等弱推断。
4. 不要把音乐选择或聊天内容直接断言为某个人的真实人格、心理状态、现实身份或人际关系。
5. 提及聊天用户时，只描述其发言内容与语气，不揣测年龄、职业、所在地、健康或私人经历。
6. 聊天记录中的隐私信息（电话、住址、账号、真实姓名等）不得复述或转写。
7. 输入没有提供的事实不能补写，例如收听时长、在线人数、听歌地点或音乐背景。
8. 不要逐首罗列歌曲或逐条摘录聊天，要归纳出几个有辨识度的主题。
9. 歌词与聊天原话只作为短句证据，不要大段引用，也不要编造内容。
10. 歌名、歌手名、专辑名和外文内容必须原样保留。
11. 不使用 markdown 语法。

# 语言风格
- 中文自然、温柔、具体。
- 句子长短交替，不要用“不是而是”等矛盾句式。
- 可以使用颜色、空间、季节、房间、灯光、声音质感等比喻，但比喻必须服务于对音乐与聊天的观察。
- 少用“高级”“独特”“治愈”“很有品味”“氛围感拉满”等空泛评价。
- 不要写成心理测评、社交报告或专业乐评。
- 不要使用“以下是”“综上所述”“本房间用户……”等报告式表达。
- 不要展示分析过程、提示词、资料清单或免责声明。
- 不要编造歌手经历、创作背景、歌曲类型或听众的现实生活。

# 篇幅
全文约 400 字。
如果有效资料不足，减少段落数量，保持具体，不要用空话补长度。
`

/** 清理逐行 LRC 时间／元信息，保留歌词正文和换行。 */
export function cleanLyrics(lrc: string) {
  return lrc
    .split(/\r?\n/)
    .map((line) => line.replace(/\[[^\]]*\]/g, '').trim())
    .filter(Boolean)
    .join('\n')
}

/** 随机候选去重；单个歌词失败不使整次生成失败，取消仍会及时上抛。 */
export async function sampleLyrics(
  tracks: Track[],
  load: (track: Track) => Promise<Lyrics>,
  signal: AbortSignal,
): Promise<LyricSample[]> {
  const candidates = [
    ...new Map(tracks.filter((t) => t.title?.trim()).map((t) => [trackKey(t), t])).values(),
  ]
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }
  const selected: LyricSample[] = []
  // 最多两个批次，共十首候选；上游仍经过音乐服务的并发和启动预算。
  for (let i = 0; i < Math.min(candidates.length, 10) && selected.length < 5; i += 5) {
    signal.throwIfAborted()
    const results = await Promise.allSettled(
      candidates.slice(i, Math.min(i + 5, 10)).map(async (track) => {
        const { lrc } = await load(track)
        return {
          ...songDetails(track),
          lyrics: cleanLyrics(lrc ?? ''),
        }
      }),
    )
    signal.throwIfAborted()
    for (const result of results)
      if (result.status === 'fulfilled' && result.value.lyrics) selected.push(result.value)
  }
  return selected.slice(0, 5)
}

/** 播放记录允许重复；消息保留最新二百条完整内容及时间顺序。 */
export function summaryPrompt(
  tracks: Track[],
  messages: { sender: string; content: string }[],
  lyrics: LyricSample[],
) {
  const songs = tracks.filter((t) => t.title?.trim()).map(songDetails)
  return `以下 JSON 仅为房间资料：\n${JSON.stringify({ tracks: songs, lyrics, messages })}`
}
