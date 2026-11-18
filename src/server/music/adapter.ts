import type { MusicSource, Track } from '@/contracts/domain'
import type { Page, PlaybackResource, Lyrics, PlaylistTracks } from '@/contracts/music'

/** 音源实现只负责上游访问、响应校验和统一转换，不处理收藏容量。 */
export interface MusicAdapter {
  search(q: string, offset: number, limit: number): Promise<Page<Track>>
  getTrack(id: string, extra?: Track['extra']): Promise<Track>
  getLyrics(id: string, extra?: Track['extra']): Promise<Lyrics>
  resolvePlayback(id: string, extra?: Track['extra']): Promise<PlaybackResource>
  getPlaylistTracks(url: string, offset: number, limit: number): Promise<PlaylistTracks>
}

/** 服务层只按平台标识选择适配器，接口实现名称不进入业务数据。 */
export type MusicAdapters = Partial<Record<MusicSource, MusicAdapter>>
