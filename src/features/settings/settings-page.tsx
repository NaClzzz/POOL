'use client'
import styles from '@/features/settings/settings-page.module.css'
import sharedStyles from '@/components/presentation.module.css'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { Check, LogOut, RotateCcw, Volume2 } from 'lucide-react'
import { useSession } from '@/stores/session'
import { usePlayer } from '@/stores/player'
import { api, fillLikes, getDatabase, resetDemo, setScenario } from '@/mocks/api'
import type { DemoScenario } from '@/contracts/domain'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { Slider } from '@/components/ui/slider'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

/** 本地偏好、可重复演示场景与账号退出，操作不连接后端。 */
export function SettingsPage() {
  const user = useSession((s) => s.user!)
  const volume = usePlayer((s) => s.volume)
  const setVolume = usePlayer((s) => s.setVolume)
  const [scenario, updateScenario] = useState<DemoScenario>(() => getDatabase().scenario)
  const [notice, setNotice] = useState('')
  const [resetOpen, setResetOpen] = useState(false)
  const client = useQueryClient()
  const router = useRouter()
  /** 场景改变后失效查询，但不退出模拟会话。 */
  const selectScenario = (value: DemoScenario) => {
    setScenario(value)
    updateScenario(value)
    void client.invalidateQueries()
    setNotice('演示场景已切换')
  }
  /** 重置仅清理 POOL 原型命名空间，保留当前演示身份。 */
  const reset = () => {
    resetDemo()
    updateScenario('normal')
    usePlayer.getState().reset()
    client.clear()
    setNotice('演示数据已重置，可以重新开始')
    setResetOpen(false)
  }
  /** 账号退出同时停止音频及清除私有缓存。 */
  const logout = () => {
    api.logout()
    useSession.getState().setUser(null)
    usePlayer.getState().reset()
    client.clear()
    router.replace('/login')
  }
  const scenarios: [DemoScenario, string, string][] = [
    ['normal', '正常', '流畅地体验完整流程'],
    ['slow', '慢加载', '查看加载及提交中的状态'],
    ['offline', '服务不可用', '查看错误反馈与重试入口'],
    ['limited', '请求受限', '查看频率限制反馈'],
    ['ai-fail', 'AI 生成失败', '查看失败及手动重试状态'],
  ]
  return (
    <div className={styles.settingsPage}>
      <PageHeader name="Settings" title="设置" />
      <section className={styles.settingsSection}>
        <div className={styles.settingsSectionHeading}>
          <h2 className={styles.sectionTitle}>我的账号</h2>
        </div>
        <div className={styles.accountCard}>
          <span className={cn(sharedStyles.avatar, sharedStyles.avatarLg)}>
            {user.name.slice(0, 1)}
          </span>
          <div className="flex-1">
            <h3 className={styles.accountName}>{user.name}</h3>
            <p className={styles.accountEmail}>{user.email}</p>
          </div>
          <Button variant="outline" onClick={logout}>
            <LogOut />
            退出登录
          </Button>
        </div>
      </section>
      <section className={styles.settingsSection}>
        <div className={styles.settingsSectionHeading}>
          <h2 className={styles.sectionTitle}>播放偏好</h2>
        </div>
        <div className={styles.settingRow}>
          <div>
            <h3 className={styles.settingTitle}>默认音量</h3>
            <p className={styles.settingDescription}>个人播放器和房间音频共用此偏好。</p>
          </div>
          <div className={styles.volumeSetting}>
            <Volume2 size={18} />
            <Slider
              className={styles.volumeSlider}
              aria-label="默认音量"
              min={0}
              max={1}
              step={0.01}
              value={[volume]}
              onValueChange={(value) => setVolume((value as number[])[0])}
            />
            <span className={styles.volumeValue}>{Math.round(volume * 100)}%</span>
          </div>
        </div>
      </section>
      <section className={styles.settingsSection}>
        <div className={styles.settingsSectionHeading}>
          <h2 className={styles.sectionTitle}>演示选项</h2>
        </div>
        <p className={styles.settingsDescription}>
          所有数据都留在当前浏览器，可重复检查不同交互状态。
        </p>
        <div className={styles.scenarioGrid}>
          {scenarios.map(([value, title, text]) => (
            <button
              className={cn(
                styles.scenarioOption,
                value === scenario && styles.selected,
                sharedStyles.action,
              )}
              key={value}
              onClick={() => selectScenario(value)}
            >
              <span className={styles.scenarioHeading}>
                {title}
                {value === scenario && <Check size={15} />}
              </span>
              <small className={styles.scenarioDescription}>{text}</small>
            </button>
          ))}
        </div>
        <div className={styles.settingRow}>
          <div>
            <h3 className={styles.settingTitle}>长列表与收藏上限</h3>
            <p className={styles.settingDescription}>
              准备 498 首喜欢，验证长列表与导入至 500 首的行为。
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              fillLikes()
              void client.invalidateQueries({ queryKey: ['likes', user.id] })
              setNotice('已准备 498 首喜欢，去喜欢页查看')
            }}
          >
            准备容量演示
          </Button>
        </div>
        <div className={styles.settingRow}>
          <div>
            <h3 className={styles.settingTitle}>重置演示数据</h3>
            <p className={styles.settingDescription}>重置喜欢、房间、历史、总结和演示场景。</p>
          </div>
          <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
            <AlertDialogTrigger render={<Button variant="outline" />}>
              <RotateCcw />
              重置演示数据
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>重置演示数据？</AlertDialogTitle>
                <AlertDialogDescription>
                  喜欢、房间、历史、总结和演示场景将恢复默认值。当前登录会保留。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={reset}>
                  确认重置
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {notice && (
          <p className={styles.settingsNotice} role="status">
            <Check size={15} />
            {notice}
          </p>
        )}
      </section>
    </div>
  )
}
