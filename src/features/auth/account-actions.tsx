'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { isAccountFormError, useUpdateAccount } from '@/lib/api-client'
import { useSession } from '@/stores/session'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import styles from '@/components/presentation.module.css'

/** 已登录账号的资料与密码修改字段；密码不进入持久状态。 */
type AccountFields = {
  name: string
  currentPassword: string
  newPassword: string
  confirmPassword: string
}

/** 账号设置仅提供已接通的昵称和密码修改，不展示未接邮件的找回入口。 */
export function AccountActions() {
  const user = useSession((state) => state.user!)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'name' | 'password'>('name')
  const form = useForm<AccountFields>({
    shouldUnregister: true,
    defaultValues: { name: user.name, currentPassword: '', newPassword: '', confirmPassword: '' },
  })

  const update = useUpdateAccount({
    onSuccess: (_data, input) => {
      setOpen(false)
      form.reset({
        name: input.mode === 'name' ? input.name : user.name,
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      })
    },
  })
  /** 表单只提交当前操作的输入，成功收尾与请求反馈由业务 hook 协调。 */
  const submit = (values: AccountFields) => {
    update.mutate(
      mode === 'name'
        ? { mode, name: values.name.trim() }
        : { mode, currentPassword: values.currentPassword, newPassword: values.newPassword },
    )
  }

  return (
    <div className="mt-4">
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          update.reset()
          if (!value)
            form.reset({
              name: user.name,
              currentPassword: '',
              newPassword: '',
              confirmPassword: '',
            })
        }}
      >
        <div className="flex gap-2">
          <DialogTrigger
            render={<Button variant="outline" size="sm" />}
            onClick={() => {
              setMode('name')
              update.reset()
              form.reset({
                name: user.name,
                currentPassword: '',
                newPassword: '',
                confirmPassword: '',
              })
            }}
          >
            修改昵称
          </DialogTrigger>
          <DialogTrigger
            render={<Button variant="outline" size="sm" />}
            onClick={() => {
              setMode('password')
              update.reset()
              form.reset()
            }}
          >
            修改密码
          </DialogTrigger>
        </div>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{mode === 'name' ? '修改昵称' : '修改密码'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(submit)}>
            {mode === 'name' ? (
              <label className={styles.field}>
                昵称
                <Input
                  className={styles.fieldInput}
                  maxLength={30}
                  {...form.register('name', {
                    validate: (value) => !!value.trim() || '请输入昵称',
                    maxLength: { value: 30, message: '昵称最多 30 字符' },
                  })}
                />
              </label>
            ) : (
              <>
                <label className={styles.field}>
                  当前密码
                  <Input
                    className={styles.fieldInput}
                    type="password"
                    autoComplete="current-password"
                    {...form.register('currentPassword', { required: '请输入当前密码' })}
                  />
                </label>
                <label className={styles.field}>
                  新密码
                  <Input
                    className={styles.fieldInput}
                    type="password"
                    autoComplete="new-password"
                    {...form.register('newPassword', {
                      required: '请输入新密码',
                      minLength: { value: 8, message: '新密码至少 8 位' },
                      maxLength: { value: 128, message: '新密码最多 128 位' },
                    })}
                  />
                </label>
                <label className={styles.field}>
                  确认新密码
                  <Input
                    className={styles.fieldInput}
                    type="password"
                    autoComplete="new-password"
                    {...form.register('confirmPassword', {
                      validate: (value) =>
                        value === form.getValues('newPassword') || '两次密码输入不一致',
                    })}
                  />
                </label>
              </>
            )}
            {Object.values(form.formState.errors).map((error, index) => (
              <p key={index} role="alert" className={styles.fieldError}>
                {error.message}
              </p>
            ))}
            {isAccountFormError(update.error) && (
              <p role="alert" className={styles.fieldError}>
                {update.error.message}
              </p>
            )}
            <Button className="mt-4 w-full" type="submit" disabled={update.isPending}>
              {update.isPending ? '正在保存…' : '保存'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
