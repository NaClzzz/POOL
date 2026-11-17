'use client'
import { Feather, LoaderCircle, RotateCcw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePlaylistAnalysisGeneration } from '@/lib/api-client'
import styles from './generation-panel.module.css'
import shared from '@/components/presentation.module.css'

/** 喜欢列表上方的流式赏析；离页取消请求，按账号恢复最近一次完整结果。 */
export function GenerationPanel() {
  const generation = usePlaylistAnalysisGeneration()
  return (
    <section
      className={styles.generationPanel}
      aria-label="歌单分析"
      aria-busy={generation.pending}
    >
      <div className={styles.generationHeading}>
        <h2>歌单分析</h2>

        {generation.pending ? (
          <Button variant="ghost" size="sm" onClick={() => void generation.stop()}>
            <Square />
            取消
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={generation.generate}>
            {generation.text || generation.error ? <RotateCcw /> : <Feather />}
            {generation.text || generation.error ? '重新生成' : '生成分析'}
          </Button>
        )}
      </div>
      {generation.error && (
        <p role="alert" className={shared.inlineError}>
          {generation.error.message}
        </p>
      )}
      {generation.text && <div className={styles.generatedCopy}>{generation.text}</div>}
      {generation.pending && (
        <p className={styles.generationStatus} role="status">
          <LoaderCircle className="size-4 animate-spin" />
          正在生成…
        </p>
      )}
    </section>
  )
}
