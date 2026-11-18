'use client'

import sharedStyles from '@/components/presentation.module.css'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { Plus } from 'lucide-react'
import { useCreateRoom } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'

/** 大厅创建表单只提交业务字段，不接受客户端提供的所有者。 */
type CreateFields = {
  name: string
  tag: string
  maxMembers: number
  maxStageMembers: number
  protected: boolean
  password: string
}

/** 创建表单管理输入草稿，成功后导航到真实房间。 */
export function CreateRoomDialog() {
  const [createOpen, setCreateOpen] = useState(false)
  const router = useRouter()
  const form = useForm<CreateFields>({
    defaultValues: {
      name: '',
      tag: '',
      maxMembers: 10,
      maxStageMembers: 10,
      protected: false,
      password: '',
    },
  })
  const create = useCreateRoom({
    onSuccess: (room) => {
      setCreateOpen(false)
      router.push(`/rooms/${room.roomCode}`)
    },
  })
  return (
    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      <DialogTrigger render={<Button />} onClick={() => create.reset()}>
        <Plus />
        创建房间
      </DialogTrigger>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>创建房间</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={form.handleSubmit((values) =>
            create.mutate({
              name: values.name,
              tag: values.tag,
              maxMembers: values.maxMembers,
              maxStageMembers: values.maxStageMembers,
              ...(values.protected ? { password: values.password } : {}),
            }),
          )}
        >
          <label className={sharedStyles.field}>
            房间名称
            <Input
              className={sharedStyles.fieldInput}
              placeholder="输入房间名称"
              {...form.register('name', { required: true, minLength: 2, maxLength: 20 })}
            />
          </label>
          <label className={sharedStyles.field}>
            房间标签
            <Input
              className={sharedStyles.fieldInput}
              {...form.register('tag', { required: true, minLength: 2, maxLength: 12 })}
            />
          </label>
          <div className={sharedStyles.formColumns}>
            <label className={sharedStyles.field}>
              房间人数
              <Input
                className={sharedStyles.fieldInput}
                type="number"
                min={2}
                max={50}
                {...form.register('maxMembers', { valueAsNumber: true, min: 2, max: 50 })}
              />
            </label>
            <label className={sharedStyles.field}>
              上台人数
              <Input
                className={sharedStyles.fieldInput}
                type="number"
                min={1}
                max={30}
                {...form.register('maxStageMembers', { valueAsNumber: true, min: 1, max: 30 })}
              />
            </label>
          </div>
          <label className={sharedStyles.checkboxField}>
            <Controller
              name="protected"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  name={field.name}
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  onBlur={field.onBlur}
                  ref={field.ref}
                />
              )}
            />
            设置为密码房
          </label>
          {form.watch('protected') && (
            <label className={sharedStyles.field}>
              房间密码
              <Input
                type="password"
                minLength={6}
                maxLength={64}
                autoComplete="new-password"
                {...form.register('password', {
                  required: form.watch('protected'),
                  minLength: 6,
                  maxLength: 64,
                })}
              />
            </label>
          )}
          {Object.keys(form.formState.errors).length > 0 && (
            <p className={sharedStyles.inlineError}>请检查名称、标签和人数设置。</p>
          )}
          {create.error && <p className={sharedStyles.inlineError}>{create.error.message}</p>}
          <Button type="submit" className="mt-5 w-full" disabled={create.isPending}>
            <Plus />
            {create.isPending ? '正在创建…' : '创建并进入'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
