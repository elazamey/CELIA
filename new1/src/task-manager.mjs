import { EventEmitter } from 'node:events'
import { runAgentTask } from './agent.mjs'
import { WorkspaceTools } from './tools.mjs'

export class TaskManager extends EventEmitter {
  constructor({ config, store, provider, streaming = true }) {
    super()
    this.config = config
    this.store = store
    this.provider = provider
    this.streaming = streaming
    this.active = new Map()
    this.pendingApprovals = new Map()
  }

  publish(task) {
    this.emit('update', task)
    return task
  }

  list() {
    return this.store.list()
  }

  get(id) {
    return this.store.get(id)
  }

  stats() {
    return this.store.stats()
  }

  create(input) {
    const prompt = String(input.prompt ?? '').trim()
    if (prompt.length < 2) throw new Error('اكتب وصفًا واضحًا للمهمة')
    if (prompt.length > 12_000) throw new Error('وصف المهمة أطول من 12,000 حرف')
    const mode = input.mode === 'team' ? 'team' : 'agent'
    const model = String(input.model ?? this.config.model).trim().slice(0, 160)
    if (!model) throw new Error('اختر نموذجًا محليًا')
    const approvalPolicy = input.approvalPolicy === 'approve-writes' ? 'approve-writes' : 'auto'

    const task = this.store.create({
      prompt,
      mode,
      model,
      allowCommands: input.allowCommands === true,
      approvalPolicy
    })
    this.publish(task)
    this.pump()
    return task
  }

  resume(id) {
    const existing = this.store.get(id)
    if (!existing) return null
    if (!['failed', 'cancelled'].includes(existing.status)) {
      throw new Error('لا يمكن استئناف سوى المهام المتوقفة أو الفاشلة')
    }
    this.store.addActivity(
      id,
      'status',
      existing.checkpoint
        ? 'تمت جدولة الاستئناف من آخر نقطة حفظ للسياق.'
        : 'تمت إعادة جدولة المهمة من البداية.',
      { role: 'system' }
    )
    const updated = this.store.update(id, {
      status: 'queued',
      error: '',
      pendingApproval: null
    })
    this.publish(updated)
    this.pump()
    return updated
  }

  approve(id, { approved, note = '' } = {}) {
    const waiter = this.pendingApprovals.get(id)
    const task = this.store.get(id)
    if (!task) return null
    if (!waiter || task.status !== 'awaiting_approval') {
      throw new Error('لا توجد موافقة معلّقة لهذه المهمة')
    }
    this.pendingApprovals.delete(id)
    const updated = this.store.update(id, {
      status: 'running',
      pendingApproval: null
    })
    this.publish(updated)
    waiter.resolve({ approved: Boolean(approved), note: String(note ?? '') })
    return updated
  }

  deleteTask(id) {
    const task = this.store.get(id)
    if (!task) return false
    if (this.active.has(id)) {
      this.cancel(id)
    }
    const deleted = this.store.delete(id)
    if (deleted) this.emit('deleted', { id })
    return deleted
  }

  clearFinished() {
    const removed = this.store.clearFinished()
    if (removed > 0) this.emit('cleared', { removed })
    return removed
  }

  exportBundle() {
    return this.store.exportBundle()
  }

  importBundle(payload) {
    const imported = this.store.importBundle(payload)
    this.emit('imported', { imported })
    return imported
  }

  pump() {
    if (this.active.size >= this.config.maxConcurrency) return
    const next = this.store
      .list()
      .reverse()
      .find((task) => task.status === 'queued')
    if (!next) return
    this.execute(next.id)
  }

  async execute(id) {
    const task = this.store.get(id)
    if (!task || task.status !== 'queued') return
    const controller = new AbortController()
    this.active.set(id, controller)
    this.publish(this.store.update(id, { status: 'running', error: '', pendingApproval: null }))

    const tools = new WorkspaceTools({
      workspaceDir: this.config.workspaceDir,
      allowCommands: task.allowCommands,
      commandTimeoutMs: this.config.commandTimeoutMs
    })

    try {
      const result = await runAgentTask({
        task,
        provider: this.provider,
        tools,
        signal: controller.signal,
        maxSteps: this.config.maxSteps,
        onActivity: (type, content, detail) => {
          this.publish(this.store.addActivity(id, type, content, detail))
        },
        onStream: this.streaming
          ? ({ role, reset, delta }) => {
              this.emit('stream', { taskId: id, role, reset, delta })
            }
          : null,
        onCheckpoint: (checkpoint) => {
          this.store.update(id, { checkpoint })
        },
        requestApproval: (requestInfo) =>
          new Promise((resolve) => {
            const pendingApproval = {
              ...requestInfo,
              requestedAt: new Date().toISOString()
            }
            this.pendingApprovals.set(id, { resolve })
            this.publish(
              this.store.update(id, {
                status: 'awaiting_approval',
                pendingApproval
              })
            )
          })
      })
      this.publish(this.store.update(id, { status: 'completed', result, pendingApproval: null }))
    } catch (error) {
      const cancelled = controller.signal.aborted || error.name === 'AbortError'
      this.publish(
        this.store.update(id, {
          status: cancelled ? 'cancelled' : 'failed',
          pendingApproval: null,
          error: cancelled ? 'أُلغيت المهمة بطلب المستخدم.' : error.message
        })
      )
    } finally {
      this.pendingApprovals.delete(id)
      this.active.delete(id)
      this.pump()
    }
  }

  cancel(id) {
    const task = this.store.get(id)
    if (!task) return null
    if (task.status === 'queued') {
      return this.publish(
        this.store.update(id, {
          status: 'cancelled',
          pendingApproval: null,
          error: 'أُلغيت المهمة قبل بدء التشغيل.'
        })
      )
    }
    const controller = this.active.get(id)
    if (controller) controller.abort()
    const waiter = this.pendingApprovals.get(id)
    if (waiter) {
      this.pendingApprovals.delete(id)
      waiter.resolve({ approved: false, note: 'cancelled' })
    }
    return task
  }

  shutdown() {
    for (const waiter of this.pendingApprovals.values()) {
      waiter.resolve({ approved: false, note: 'shutdown' })
    }
    this.pendingApprovals.clear()
    for (const controller of this.active.values()) controller.abort()
  }
}
