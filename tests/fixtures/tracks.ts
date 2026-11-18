import type { Track } from '@/contracts/domain'

const records = [
  ['水面来信', '知更', '漂浮日记'],
  ['慢慢靠岸', '岛屿来客', '蓝色时刻'],
  ['After the Rain', 'Luna Park', 'Soft Focus'],
  ['星期五的风', '北岸电台', '空想散步'],
  ['Moonlit Walk', 'Mellow Coast', 'Night Letters'],
  ['橘子海岸', '空白航线', '温柔宇宙'],
  ['不必赶路', '知更', '漂浮日记'],
  ['Cloud Nine', 'Luna Park', 'Soft Focus'],
  ['房间里的夏天', '岛屿来客', '蓝色时刻'],
  ['夜航星', '北岸电台', '夜的另一边'],
  ['日落之后', '空白航线', '温柔宇宙'],
  ['Somewhere Quiet', 'Mellow Coast', 'Night Letters'],
] as const

/** 仅供队列、房间及 AI 单元测试使用的混源曲目资料，不关联媒体资源。 */
export const catalog: Track[] = Array.from({ length: 60 }, (_, i) => {
  const row = records[i % records.length]
  return {
    source: i % 4 === 3 ? 'bilibili' : 'netease',
    source_id: `fixture-${i + 1}`,
    title: `${row[0]}${i >= records.length ? ` · ${Math.floor(i / records.length) + 1}` : ''}`,
    author: row[1],
    album: row[2],
    duration_ms: 180_000,
    cover_url: null,
    extra: null,
  }
})
