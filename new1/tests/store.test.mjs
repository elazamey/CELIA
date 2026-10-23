import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStore } from '../src/store.mjs'

test('TaskStore persists tasks, activity, and statistics', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'new1-store-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))

  const store = new TaskStore(dataDir).init()
  const task = store.create({ prompt: 'اكتب ملفًا', mode: 'agent', model: 'local:test', allowCommands: false })
  store.addActivity(task.id, 'status', 'بدأ التنفيذ', { role: 'builder' })
  store.update(task.id, { status: 'completed', result: 'تم' })

  const restored = new TaskStore(dataDir).init()
  const saved = restored.get(task.id)
  assert.equal(saved.status, 'completed')
  assert.equal(saved.result, 'تم')
  assert.equal(saved.activity.length, 1)
  assert.equal(saved.activity[0].detail.role, 'builder')
  assert.deepEqual(restored.stats(), { total: 1, active: 0, completed: 1, failed: 0 })
})

test('TaskStore marks interrupted work as failed after restart', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'new1-recovery-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))

  const store = new TaskStore(dataDir).init()
  const task = store.create({ prompt: 'test', mode: 'agent', model: 'local:test', allowCommands: false })
  store.update(task.id, { status: 'running' })

  const restored = new TaskStore(dataDir).init()
  assert.equal(restored.get(task.id).status, 'failed')
  assert.match(restored.get(task.id).error, /إعادة تشغيل/)
})
