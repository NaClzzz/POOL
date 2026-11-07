import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { catalog } from '@/mocks/fixtures'

describe('离线演示资源', () => {
  for (const audio of ['tide', 'dusk']) {
    it(`${audio} 是与曲库时长一致的本地 PCM 音频`, () => {
      const data = readFileSync(join(process.cwd(), 'public', 'audio', `${audio}.wav`))
      expect(data.toString('ascii', 0, 4)).toBe('RIFF')
      expect(data.toString('ascii', 8, 12)).toBe('WAVE')
      const bytesPerSecond = data.readUInt32LE(28)
      const duration = data.readUInt32LE(40) / bytesPerSecond
      expect(duration).toBe(24)
      for (const track of catalog.filter((t) => t.extra?.demoAudio === audio))
        expect(track.duration_ms).toBe(duration * 1000)
    })
  }

  it('每个曲目封面都存在且无需访问远程图片服务', () => {
    for (const track of catalog) {
      expect(track.cover_url?.startsWith('/covers/')).toBe(true)
      expect(existsSync(join(process.cwd(), 'public', track.cover_url!))).toBe(true)
    }
  })
})
