import type { MusicSource, Track } from '@/contracts/domain'
import type { MusicAdapters } from './adapter'
import { neteaseAdapter } from './adapters/netease'
import { BusinessError } from '../http/errors'

const adapters: MusicAdapters = {
  netease: neteaseAdapter,
}

/** 根据音源选择适配器，未接通的平台显式返回未支持。 */
function adapterFor(source: MusicSource) {
  const adapter = adapters[source]
  if (!adapter) throw new BusinessError('CAPABILITY_NOT_SUPPORTED', '该音源暂未接入', 501)
  return adapter
}

/** 业务层唯一音乐入口；平台字段与上游 URL 均停留在适配器内部。 */
export const musicService = {
  search: (source: MusicSource, q: string, offset: number, limit: number) =>
    adapterFor(source).search(q, offset, limit),
  getTrack: (source: MusicSource, id: string, extra: Track['extra'] = null) =>
    adapterFor(source).getTrack(id, extra),
  getLyrics: (source: MusicSource, id: string, extra: Track['extra'] = null) =>
    adapterFor(source).getLyrics(id, extra),
  resolvePlayback: (source: MusicSource, id: string, extra: Track['extra'] = null) =>
    adapterFor(source).resolvePlayback(id, extra),
  getPlaylistTracks: (source: MusicSource, url: string, offset: number, limit: number) =>
    adapterFor(source).getPlaylistTracks(url, offset, limit),
}
