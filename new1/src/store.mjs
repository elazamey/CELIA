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
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'failed'
        task.error = 'توقفت المهمة بسبب إعادة تشغيل الخادم. أنشئ مهمة جديدة للمتابعة.'
        task.updatedAt = new Date().toISOString()
        changed = true
      }
    }
    if (changed) this.persist()
  }

  persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
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

  create({ prompt, mode, model, allowCommands }) {
    const now = new Date().toISOString()
    const task = {
      id: randomUUID(),
      title: prompt.replace(/\s+/g, ' ').trim().slice(0, 76),
      prompt,
      mode,
      model,
      allowCommands,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      result: '',
      error: '',
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
      active: tasks.filter((task) => task.status === 'running' || task.status === 'queued').length,
      completed: tasks.filter((task) => task.status === 'completed').length,
      failed: tasks.filter((task) => task.status === 'failed').length
    }
  }

  isTerminal(id) {
    const task = this.tasks.get(id)
    return !task || TERMINAL_STATUSES.has(task.status)
  }
}
