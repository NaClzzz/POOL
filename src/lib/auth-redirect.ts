/** 登录回跳只接受站内绝对路径，拒绝协议相对地址和浏览器会归一化的反斜杠。 */
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
