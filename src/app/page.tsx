import { redirect } from 'next/navigation'

/** 根地址统一进入搜索，由服务端真实会话边界决定是否登录。 */
export default function Home() {
  redirect('/search')
}
