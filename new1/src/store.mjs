import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const ACTIVE_STATUSES = new Set(['running', 'queued', 'awaiting_approval'])

function clone(value) {
  return structuredClone(value)
}

export class TaskStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.filePath = join(dataDir, 'tasks.json')
    this.tasks = new Map()
  }

  init() {
    mkdirSync(this.dataDir, { recursive: true })
    if (existsSync(this.filePath)) {
      const saved = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (!Array.isArray(saved.tasks)) throw new Error('Invalid NEW1 task store')
      for (const task of saved.tasks) this.tasks.set(task.id, task)
    }
    this.recoverInterruptedTasks()
    return this
  }

  recoverInterruptedTasks() {
    let changed = false
    for (const task of this.tasks.values()) {
      if (ACTIVE_STATUSES.has(task.status)) {
        task.status = 'failed'
        task.pendingApproval = null
        task.error = task.checkpoint
          ? 'توقفت المهمة بسبب إعادة تشغيل الخادم. يمكنك استئنافها من آخر سياق محفوظ.'
          : 'توقفت المهمة بسبب إعادة تشغيل الخادم. أنشئ مهمة جديدة أو أعد تشغيلها.'
        task.updatedAt = new Date().toISOString()
        changed = true
      }
    }
    if (changed) this.persist()
  }

  persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, JSON.stringify({ tasks: this.list() }, null, 2))
    renameSync(temporaryPath, this.filePath)
  }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone)
  }

  get(id) {
    const task = this.tasks.get(id)
    return task ? clone(task) : null
  }

  create({ prompt, mode, model, allowCommands, approvalPolicy = 'auto' }) {
    const now = new Date().toISOString()
    const task = {
      id: randomUUID(),
      title: prompt.replace(/\s+/g, ' ').trim().slice(0, 76),
      prompt,
      mode,
      model,
      allowCommands: Boolean(allowCommands),
      approvalPolicy: approvalPolicy === 'approve-writes' ? 'approve-writes' : 'auto',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      result: '',
      error: '',
      pendingApproval: null,
      checkpoint: null,
      activity: []
    }
    this.tasks.set(task.id, task)
    this.persist()
    return clone(task)
  }

  update(id, patch) {
    const task = this.tasks.get(id)
    if (!task) throw new Error('Task not found')
    Object.assign(task, patch, { updatedAt: new Date().toISOString() })
    this.persist()
    return clone(task)
  }

  delete(id) {
    const existed = this.tasks.delete(id)
    if (existed) this.persist()
    return existed
  }

  clearFinished() {
    let removed = 0
    for (const [id, task] of this.tasks.entries()) {
      if (TERMINAL_STATUSES.has(task.status)) {
        this.tasks.delete(id)
        removed += 1
      }
    }
    if (removed > 0) this.persist()
    return removed
  }

  exportBundle() {
    return {
      schema: 'new1.tasks.v2',
      exportedAt: new Date().toISOString(),
      tasks: this.list()
    }
  }

  importBundle(payload) {
    if (!payload || !Array.isArray(payload.tasks)) {
      throw new Error('ملف الاستيراد لا يحتوي على قائمة مهام صالحة')
    }
    let imported = 0
    for (const raw of payload.tasks) {
      if (!raw || typeof raw.prompt !== 'string' || !raw.prompt.trim()) continue
      const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : randomUUID()
      const status = TERMINAL_STATUSES.has(raw.status) ? raw.status : 'failed'
      this.tasks.set(id, {
        id,
        title: String(raw.title ?? raw.prompt).replace(/\s+/g, ' ').trim().slice(0, 76),
        prompt: raw.prompt,
        mode: raw.mode === 'team' ? 'team' : 'agent',
        model: String(raw.model ?? 'qwen3:8b'),
        allowCommands: Boolean(raw.allowCommands),
        approvalPolicy: raw.approvalPolicy === 'approve-writes' ? 'approve-writes' : 'auto',
        status,
        createdAt: raw.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        result: String(raw.result ?? ''),
        error: String(raw.error ?? ''),
        pendingApproval: null,
        checkpoint: raw.checkpoint ?? null,
        activity: Array.isArray(raw.activity) ? raw.activity.slice(-400) : []
      })
      imported += 1
    }
    if (imported > 0) this.persist()
    return imported
  }

  addActivity(id, type, content, detail = {}) {
    const task = this.tasks.get(id)
    if (!task) throw new Error('Task not found')
    task.activity.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      type,
      content: String(content).slice(0, 12_000),
      detail
    })
    if (task.activity.length > 400) task.activity = task.activity.slice(-400)
    task.updatedAt = new Date().toISOString()
    this.persist()
    return clone(task)
  }

  stats() {
    const tasks = [...this.tasks.values()]
    return {
      total: tasks.length,
      active: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      completed: tasks.filter((task) => task.status === 'completed').length,
      failed: tasks.filter((task) => task.status === 'failed').length
    }
  }

  isTerminal(id) {
    const task = this.tasks.get(id)
    return !task || TERMINAL_STATUSES.has(task.status)
  }
}
