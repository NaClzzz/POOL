/** 登录回跳 */
export function authReturnTo(target: string | null) {
  if (
    !target ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    /[\\\u0000-\u001f]/.test(target)
  )
    return '/search'
  return target
}
