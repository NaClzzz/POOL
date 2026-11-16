'use client'
import styles from './settings-page.module.css'
import shared from '@/components/presentation.module.css'
import { cn } from '@/lib/utils'
import { LogOut, Volume2 } from 'lucide-react'
import { useSession } from '@/stores/session'
import { usePlayer } from '@/stores/player'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { Slider } from '@/components/ui/slider'
import { useLogout } from '@/features/auth/use-logout'
import { AccountActions } from '@/features/auth/account-actions'

/** 真实账号与本地播放偏好，不再提供 AI 模拟场景。 */
export function SettingsPage() {
  const user = useSession((s) => s.user!)
  const volume = usePlayer((s) => s.volume)
  const setVolume = usePlayer((s) => s.setVolume)
  const { logout, pending, error: logoutError } = useLogout()
  return (
    <div className={styles.settingsPage}>
      <PageHeader name="Settings" title="设置" />
      {logoutError && (
        <p role="alert" className={shared.inlineError}>
          {logoutError}
        </p>
      )}
      <section className={styles.settingsSection}>
        <div className={styles.settingsSectionHeading}>
          <h2 className={styles.sectionTitle}>我的账号</h2>
        </div>
        <div className={styles.accountCard}>
          <span className={cn(shared.avatar, shared.avatarLg)}>{user.name.slice(0, 1)}</span>
          <div className="flex-1">
            <h3 className={styles.accountName}>{user.name}</h3>
            <p className={styles.accountEmail}>{user.email}</p>
          </div>
          <Button variant="outline" onClick={() => void logout()} disabled={pending}>
            <LogOut />
            退出登录
          </Button>
        </div>
        <AccountActions />
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
              onValueChange={(value) => setVolume(Array.isArray(value) ? value[0] : value)}
            />
            <span className={styles.volumeValue}>{Math.round(volume * 100)}%</span>
          </div>
        </div>
      </section>
    </div>
  )
}
