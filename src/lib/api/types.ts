/** 页面可追加成功后的界面动作，公共缓存刷新始终由对应 hook 先执行。 */
export type MutationSuccessOptions<TData, TVariables = void> = {
  onSuccess?: (data: TData, variables: TVariables) => void | Promise<void>
}
