import { EventEmitter } from 'node:events'
import { runAgentTask } from './agent.mjs'
import { WorkspaceTools } from './tools.mjs'

export class TaskManager extends EventEmitter {
  constructor({ config, store, provider }) {
    super()
    this.config = config
    this.store = store
    this.provider = provider
    this.active = new Map()
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

    const task = this.store.create({
      prompt,
      mode,
      model,
      allowCommands: input.allowCommands === true
    })
    this.publish(task)
    this.pump()
    return task
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
    this.publish(this.store.update(id, { status: 'running', error: '' }))

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
        }
      })
      this.publish(this.store.update(id, { status: 'completed', result }))
    } catch (error) {
      const cancelled = controller.signal.aborted || error.name === 'AbortError'
      this.publish(this.store.update(id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'أُلغيت المهمة بطلب المستخدم.' : error.message
      }))
    } finally {
      this.active.delete(id)
      this.pump()
    }
  }

  cancel(id) {
    const task = this.store.get(id)
    if (!task) return null
    if (task.status === 'queued') {
      return this.publish(this.store.update(id, {
        status: 'cancelled',
        error: 'أُلغيت المهمة قبل بدء التشغيل.'
      }))
    }
    const controller = this.active.get(id)
    if (controller) controller.abort()
    return task
  }

  shutdown() {
    for (const controller of this.active.values()) controller.abort()
  }
}
