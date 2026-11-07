import type { DemoDatabase, Track } from '@/contracts/domain'

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

/** 创建可重置的种子资料，并让历史的日期始终相对当前时间有效。 */
export function createSeed(now = Date.now()): DemoDatabase {
  const date = new Date(now).toISOString()
  const ended = new Date(now - 86_400_000).toISOString()
  return {
    version: 1,
    messages: {},
    playedSongs: {},
    scenario: 'normal',
    likes: { [DEMO_EMAIL]: catalog.slice(0, 12).map((t) => ({ ...t, addedAt: date })) },
    playlists: { [DEMO_EMAIL]: catalog.slice(0, 5) },
    rooms: [
      {
        roomId: 'room-slow',
        roomCode: 'pool-slow',
        name: '慢一点，也没关系',
        tag: '松弛一下',
        ownerId: 'mira',
        ownerName: '米拉',
        memberCount: 3,
        maxMembers: 12,
        maxStageMembers: 4,
        isPasswordProtected: false,
        cover: 'water',
        createdBy: 'mira',
        status: 'active',
        endedAt: null,
        expiresAt: null,
      },
      {
        roomId: 'room-night',
        roomCode: 'pool-night',
        name: '把今晚交给音乐',
        tag: '深夜电台',
        ownerId: 'lin',
        ownerName: '林间',
        memberCount: 2,
        maxMembers: 8,
        maxStageMembers: 3,
        isPasswordProtected: false,
        cover: 'moon',
        createdBy: 'lin',
        status: 'active',
        endedAt: null,
        expiresAt: null,
      },
      {
        roomId: 'room-coast',
        roomCode: 'pool-coast',
        name: '周末海边散步',
        tag: '一起发呆',
        ownerId: 'yu',
        ownerName: '小鱼',
        memberCount: 4,
        maxMembers: 10,
        maxStageMembers: 5,
        isPasswordProtected: true,
        cover: 'sunset',
        createdBy: 'yu',
        status: 'active',
        endedAt: null,
        expiresAt: null,
      },
      {
        roomId: 'room-memory',
        roomCode: 'pool-memory',
        name: '我们交换的十二首歌',
        tag: '旧时光',
        ownerId: 'mira',
        ownerName: '米拉',
        memberCount: 0,
        maxMembers: 12,
        maxStageMembers: 4,
        isPasswordProtected: false,
        cover: 'rain',
        createdBy: 'mira',
        status: 'ended',
        endedAt: ended,
        expiresAt: new Date(now + 6 * 86_400_000).toISOString(),
      },
      {
        roomId: 'room-evening',
        roomCode: 'pool-evening',
        name: '日落在窗边停了一会',
        tag: '晚间陪伴',
        ownerId: DEMO_EMAIL,
        ownerName: '你',
        memberCount: 0,
        maxMembers: 10,
        maxStageMembers: 4,
        isPasswordProtected: false,
        cover: 'orange',
        createdBy: DEMO_EMAIL,
        status: 'ended',
        endedAt: ended,
        expiresAt: new Date(now + 6 * 86_400_000).toISOString(),
      },
    ],
    history: {
      [DEMO_EMAIL]: [
        { roomId: 'room-memory', lastJoinedAt: ended },
        { roomId: 'room-evening', lastJoinedAt: ended },
      ],
    },
    summaries: {
      'room-memory': {
        status: 'succeeded',
        attemptId: null,
        content:
          '昨晚的房间像一扇半开的窗。\n\n从《水面来信》到《Moonlit Walk》，大家轮流把自己的片刻心情放进歌单。有人带来了轻盈的节奏，有人选了一首适合安静听完的歌。聊天里出现得最多的，是“再听一首”和“今天辛苦了”。\n\n那段没人急着说话的时间，也成了这场相聚的一部分。十二首歌过后，窗外的夜色已经很深，房间里还留着一点温暖。',
      },
    },
  }
}

export const analysisText =
  '你的歌单像一条沿着水边延伸的小路。\n\n《水面来信》与《慢慢靠岸》把日常的棱角轻轻收起，间或出现的轻快节奏，又让安静有了流动的方向。你选择的歌名里有雨、有月亮，也有无需赶路的片刻，听起来像是在为自己留一段可以呼吸的时间。\n\n如果用一种颜色形容，这份歌单是雨后偏青的蓝：清澈、柔软，带着一点对远方的好奇。下一首，试着听听《After the Rain》，让这一刻再停留一会。'
export const summaryText =
  '这次一起听，从一首轻轻展开的旋律开始。\n\n大家轮流把自己的歌放到台前，聊起今天的天气、下班路上的风，还有那些暂时没有答案的小事。几首舒缓的歌让聊天慢了下来，熟悉的节奏响起时，又有人忍不住说“这首我也喜欢”。\n\n音乐让原本不同的日常短暂地走到了一起。等最后一首歌结束，留在房间里的，是被认真听见的分享，以及一句留给下次见面的“晚安”。'
