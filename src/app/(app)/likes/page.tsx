import { requirePageUser } from '@/server/auth/session'
import { LikesPage } from '@/features/likes/likes-page'

/** 进入个人喜欢列表与网易云歌单导入流程。 */
export default async function LikesRoute() {
  await requirePageUser('/likes')
  return <LikesPage />
}
