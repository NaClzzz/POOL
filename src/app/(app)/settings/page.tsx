import { requirePageUser } from '@/server/auth/session'
import { SettingsPage } from '@/features/settings/settings-page'

/** 账号与本地演示配置入口。 */
export default async function SettingsRoute() {
  await requirePageUser('/settings')
  return <SettingsPage />
}
