import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { OllamaProvider } from '../src/provider.mjs'
import { WorkspaceTools } from '../src/tools.mjs'
import { extractToolCalls } from '../src/agent.mjs'
import { TaskStore } from '../src/store.mjs'
import { TaskManager } from '../src/task-manager.mjs'
import { createApplication } from '../src/server.mjs'
import { PROJECT_ROOT } from '../src/config.mjs'

async function waitForStatus(manager, id, targetStatuses) {
  const allowed = new Set(Array.isArray(targetStatuses) ? targetStatuses : [targetStatuses])
  for (let i = 0; i < 150; i += 1) {
    const task = manager.get(id)
    if (task && allowed.has(task.status)) return task
    await delay(10)
  }
  throw new Error(`Timed out waiting for status ${[...allowed].join('|')}`)
}

test('OllamaProvider streams NDJSON chunks and calls onToken progressively', async () => {
  const ndjson = [
    JSON.stringify({ message: { role: 'assistant', content: 'مرح' }, done: false }),
    JSON.stringify({ message: { role: 'assistant', content: 'بًا ' }, done: false }),
    JSON.stringify({ message: { role: 'assistant', content: 'بك!' }, done: true })
  ].join('\n') + '\n'

  const fetchImpl = async () =>
    new Response(ndjson, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' }
    })

  const provider = new OllamaProvider({ baseUrl: 'http://ollama:11434', model: 'qwen3:8b', fetchImpl })
  const received = []
  const msg = await provider.chat({
    messages: [{ role: 'user', content: 'hi' }],
    onToken: (delta) => received.push(delta)
  })

  assert.deepEqual(received, ['مرح', 'بًا ', 'بك!'])
  assert.equal(msg.content, 'مرحبًا بك!')
})

test('WorkspaceTools supports edit_file, make_directory, and delete_file safely', async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'new1-edit-'))
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }))
  const tools = new WorkspaceTools({ workspaceDir })

  await tools.execute('make_directory', { path: 'src/utils' })
  await tools.execute('write_file', {
    path: 'src/utils/greet.js',
    content: 'export const msg = "old";\n'
  })
  await tools.execute('edit_file', {
    path: 'src/utils/greet.js',
    old_text: '"old"',
    new_text: '"updated"'
  })
  assert.equal(
    readFileSync(join(workspaceDir, 'src/utils/greet.js'), 'utf8'),
    'export const msg = "updated";\n'
  )

  await tools.execute('delete_file', { path: 'src/utils/greet.js' })
  assert.equal(existsSync(join(workspaceDir, 'src/utils/greet.js')), false)
  await assert.rejects(() => tools.execute('delete_file', { path: '.' }), /workspace root/)
})

test('extractToolCalls parses inline <tool_call> tags emitted by local templates', () => {
  const parsed = extractToolCalls({
    role: 'assistant',
    content: 'سأنشئ الملف الآن\n<tool_call>{"name":"write_file","arguments":{"path":"a.txt","content":"hi"}}</tool_call>'
  })
  assert.equal(parsed.cleanContent, 'سأنشئ الملف الآن')
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'write_file')
  assert.equal(parsed.toolCalls[0].function.arguments.path, 'a.txt')
})

test('Human-in-the-loop approval policy pauses before disk write until approved', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'new1-approval-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const config = {
    dataDir: join(rootDir, 'data'),
    workspaceDir: join(rootDir, 'workspace'),
    model: 'local:test',
    maxConcurrency: 1,
    maxSteps: 4,
    commandTimeoutMs: 1000
  }

  let stepCount = 0
  const provider = {
    async chat() {
      stepCount += 1
      if (stepCount === 1) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'write_file', arguments: { path: 'guarded.md', content: '# Safe' } } }]
        }
      }
      return { role: 'assistant', content: 'تم الحفظ بعد الموافقة البشرية.' }
    }
  }

  const store = new TaskStore(config.dataDir).init()
  const manager = new TaskManager({ config, store, provider })
  t.after(() => manager.shutdown())

  const created = manager.create({
    prompt: 'أنشئ ملف guarded.md',
    mode: 'agent',
    approvalPolicy: 'approve-writes'
  })

  const paused = await waitForStatus(manager, created.id, 'awaiting_approval')
  assert.equal(existsSync(join(config.workspaceDir, 'guarded.md')), false)
  assert.equal(paused.pendingApproval.tool, 'write_file')

  manager.approve(created.id, { approved: true })
  const finished = await waitForStatus(manager, created.id, 'completed')
  assert.equal(existsSync(join(config.workspaceDir, 'guarded.md')), true)
  assert.equal(finished.result, 'تم الحفظ بعد الموافقة البشرية.')
})

test('HTTP server supports X-Forwarded-Host behind reverse proxies, export/import, resume, and purge', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'new1-http-v2-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))

  let failFirstAttempt = true
  const provider = {
    async health() {
      return { ok: true, status: 'ready', configuredModel: 'fake:local', modelInstalled: true, models: [{ name: 'fake:local' }] }
    },
    async listModels() {
      return [{ name: 'fake:local' }]
    },
    async chat() {
      if (failFirstAttempt) {
        failFirstAttempt = false
        throw new Error('انقطاع مؤقت في المحرك المحلي')
      }
      return { role: 'assistant', content: 'نجحت المهمة بعد الاستئناف.' }
    }
  }

  const { server, manager } = await createApplication({
    configOverrides: {
      rootDir,
      publicDir: join(PROJECT_ROOT, 'public'),
      dataDir: join(rootDir, 'data'),
      workspaceDir: join(rootDir, 'workspace'),
      orcaDir: join(rootDir, 'vendor', 'orca'),
      maxConcurrency: 1
    },
    provider
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((res) => server.close(res)))
  const base = `http://127.0.0.1:${server.address().port}`

  // Simulate reverse proxy forwarding public host while Origin matches public host
  const createRes = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://3000-sandbox.e2b.app',
      'X-Forwarded-Host': '3000-sandbox.e2b.app'
    },
    body: JSON.stringify({ prompt: 'اختبر الاستئناف', mode: 'agent', model: 'fake:local' })
  })
  assert.equal(createRes.status, 202)
  const { task } = await createRes.json()

  await waitForStatus(manager, task.id, 'failed')

  const resumeRes = await fetch(`${base}/api/tasks/${task.id}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  assert.equal(resumeRes.status, 202)
  const resumed = await waitForStatus(manager, task.id, 'completed')
  assert.equal(resumed.result, 'نجحت المهمة بعد الاستئناف.')

  const exportRes = await fetch(`${base}/api/tasks/export`)
  const bundle = await exportRes.json()
  assert.equal(bundle.tasks.length, 1)

  const purgeRes = await fetch(`${base}/api/tasks/${task.id}?purge=true`, { method: 'DELETE' })
  assert.equal(purgeRes.status, 200)
  assert.equal(manager.list().length, 0)

  const importRes = await fetch(`${base}/api/tasks/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bundle)
  })
  assert.equal(importRes.status, 200)
  assert.equal(manager.list().length, 1)
})
