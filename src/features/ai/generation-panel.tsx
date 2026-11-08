'use client'

import styles from '@/features/ai/generation-panel.module.css'
import sharedStyles from '@/components/presentation.module.css'
import { useEffect, useRef, useState } from 'react'
import { Feather, LoaderCircle, RotateCcw, Square } from 'lucide-react'
import { generateText } from '@/mocks/api'
import { Button } from '@/components/ui/button'
import type { Track } from '@/contracts/domain'

/** 固定内容分段生成界面，真实 AI SDK 由独立生成服务接入。 */
export function GenerationPanel({
  kind,
  roomId,
  initial = '',
  onComplete,
  tracks,
}: {
  kind: 'analysis' | 'summary'
  roomId?: string
  initial?: string
  onComplete?: () => void
  tracks?: Track[]
}) {
  const [text, setText] = useState(initial)
  const [status, setStatus] = useState<'idle' | 'working' | 'done' | 'error'>(
    initial ? 'done' : 'idle',
  )
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  /** 单次生成负责请求取消与状态转换，不把部分输出当成功。 */
  const generate = async () => {
    controller.current?.abort()
    controller.current = new AbortController()
    setStatus('working')
    setError('')
    setText('')
    try {
      await generateText(kind, roomId, setText, controller.current.signal, tracks)
      setStatus('done')
      onComplete?.()
    } catch (failure) {
      setStatus('error')
      setError(
        failure instanceof DOMException && failure.name === 'AbortError'
          ? '本次生成已取消，可以稍后重试。'
          : (failure as Error).message,
      )
    }
  }
  return (
    <div className={styles.generationPanel}>
      {text ? (
        <div className={styles.generatedCopy}>
          {text}
          {status === 'working' && <span className={styles.textCursor} />}
        </div>
      ) : (
        <div className={styles.generationEmpty}>
          <p className={styles.emptyDescription}>
            {kind === 'analysis' ? '尚未生成歌单分析' : '尚未生成房间总结'}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className={sharedStyles.inlineError}>
          {error}
        </p>
      )}
      <div className={styles.generationActions}>
        {status === 'working' ? (
          <>
            <span className={styles.generationStatus}>
              <LoaderCircle className="size-4 animate-spin" />
              正在生成…
            </span>
            <Button variant="outline" size="sm" onClick={() => controller.current?.abort()}>
              <Square />
              取消
            </Button>
          </>
        ) : status === 'done' ? (
          <span className={styles.generationStatus}>已生成</span>
        ) : (
          <Button onClick={() => void generate()}>
            {status === 'error' ? <RotateCcw /> : <Feather />}
            {status === 'error'
              ? '重新生成'
              : kind === 'analysis'
                ? '生成歌单分析'
                : '生成房间总结'}
          </Button>
        )}
      </div>
    </div>
  )
}
