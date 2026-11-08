/** 服务入口统一映射可预期业务失败，内部错误不直接返回给客户端。 */
export class BusinessError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryAfter?: number,
  ) {
    super(message)
    this.name = 'BusinessError'
  }
}
