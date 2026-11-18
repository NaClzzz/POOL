import { requirePageUser } from '@/server/auth/session'
import { SettingsPage } from '@/features/settings/settings-page'

/** 账号设置与本地播放偏好入口。 */
export default async function SettingsRoute() {
  await requirePageUser('/settings')
  return <SettingsPage />
}
