import { redirect } from 'next/navigation'

/** 根地址统一进入搜索，由模拟会话边界决定是否登录。 */
export default function Home() {
  redirect('/search')
}
