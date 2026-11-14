import type { Track } from '@/contracts/domain'

export const DEMO_EMAIL = 'demo@pool.local'
export const DEMO_ROOM_PASSWORD = 'pool2026'
export const DEMO_AUDIO_DURATION = 24_000
const records = [
  ['水面来信', '知更', '漂浮日记', 'water'],
  ['慢慢靠岸', '岛屿来客', '蓝色时刻', 'sunset'],
  ['After the Rain', 'Luna Park', 'Soft Focus', 'rain'],
  ['星期五的风', '北岸电台', '空想散步', 'field'],
  ['Moonlit Walk', 'Mellow Coast', 'Night Letters', 'moon'],
  ['橘子海岸', '空白航线', '温柔宇宙', 'orange'],
  ['不必赶路', '知更', '漂浮日记', 'field'],
  ['Cloud Nine', 'Luna Park', 'Soft Focus', 'water'],
  ['房间里的夏天', '岛屿来客', '蓝色时刻', 'orange'],
  ['夜航星', '北岸电台', '夜的另一边', 'moon'],
  ['日落之后', '空白航线', '温柔宇宙', 'sunset'],
  ['Somewhere Quiet', 'Mellow Coast', 'Night Letters', 'rain'],
] as const

/** 构造两种平台的演示曲库，全部映射到随项目分发的短音频。 */
export function makeTracks(count = 48): Track[] {
  return Array.from({ length: count }, (_, i) => {
    const row = records[i % records.length]
    return {
      source: i % 4 === 3 ? 'bilibili' : 'netease',
      source_id: `demo-${i + 1}`,
      title: `${row[0]}${i >= records.length ? ` · ${Math.floor(i / records.length) + 1}` : ''}`,
      author: row[1],
      album: row[2],
      duration_ms: DEMO_AUDIO_DURATION,
      cover_url: `/covers/${row[3]}.svg`,
      extra: { demoAudio: i % 2 === 0 ? 'tide' : 'dusk' },
    }
  })
}

export const catalog = makeTracks(60)
