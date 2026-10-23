import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { TaskStore } from '../src/store.mjs'
import { TaskManager } from '../src/task-manager.mjs'

async function waitForTerminal(manager, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = manager.get(id)
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task
    await delay(10)
  }
  throw new Error('Task did not finish')
}

test('manager executes a real tool call and persists the final result', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'new1-manager-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const config = {
    dataDir: join(rootDir, 'data'),
    workspaceDir: join(rootDir, 'workspace'),
    model: 'fake:local',
    maxConcurrency: 1,
    maxSteps: 4,
    commandTimeoutMs: 1000
  }
  let calls = 0
  const provider = {
    async chat({ messages }) {
      calls += 1
      if (calls === 1) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{
            function: {
              name: 'write_file',
              arguments: { path: 'result.txt', content: 'written by a local tool' }
            }
          }]
        }
      }
      assert.equal(messages.at(-1).role, 'tool')
      assert.match(messages.at(-1).content, /"ok":true/)
      return { role: 'assistant', content: 'أنشأت الملف بنجاح.' }
    }
  }

  const store = new TaskStore(config.dataDir).init()
  const manager = new TaskManager({ config, store, provider })
  t.after(() => manager.shutdown())
  const { id } = manager.create({ prompt: 'أنشئ result.txt', mode: 'agent', allowCommands: false })
  const result = await waitForTerminal(manager, id)

  assert.equal(result.status, 'completed')
  assert.equal(result.result, 'أنشأت الملف بنجاح.')
  assert.ok(existsSync(join(config.workspaceDir, 'result.txt')))
  assert.equal(readFileSync(join(config.workspaceDir, 'result.txt'), 'utf8'), 'written by a local tool')
  assert.ok(result.activity.some((item) => item.type === 'tool_result'))
})

test('manager validates prompts without starting a provider', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'new1-validation-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const config = { dataDir: join(rootDir, 'data'), workspaceDir: join(rootDir, 'workspace'), model: 'fake', maxConcurrency: 1 }
  const store = new TaskStore(config.dataDir).init()
  const manager = new TaskManager({ config, store, provider: {} })
  assert.throws(() => manager.create({ prompt: ' ' }), /وصفًا واضحًا/)
  assert.equal(manager.list().length, 0)
})
