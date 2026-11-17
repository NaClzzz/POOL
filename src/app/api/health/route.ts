/** 容器存活探针：只检查 Web 响应，不访问数据库、认证、音源或模型。 */
export function GET() {
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
