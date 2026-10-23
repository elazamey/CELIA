import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createApplication } from '../src/server.mjs'
import { PROJECT_ROOT } from '../src/config.mjs'

test('HTTP app serves the UI, health, tasks, and workspace protections', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'new1-server-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const provider = {
    async health() {
      return { ok: true, status: 'ready', configuredModel: 'fake:local', modelInstalled: true, models: [{ name: 'fake:local' }] }
    },
    async listModels() { return [{ name: 'fake:local' }] },
    async chat() { return { role: 'assistant', content: 'اكتمل الاختبار' } }
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
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`

  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /NEW1/)

  const healthResponse = await fetch(`${base}/api/health`)
  const health = await healthResponse.json()
  assert.equal(health.service, 'new1')
  assert.equal(health.orca.installed, false)

  const crossOrigin = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
    body: JSON.stringify({ prompt: 'cross origin' })
  })
  assert.equal(crossOrigin.status, 403)

  const invalid = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '' })
  })
  assert.equal(invalid.status, 400)

  const createdResponse = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'نفّذ اختبار الخادم', mode: 'agent', model: 'fake:local' })
  })
  assert.equal(createdResponse.status, 202)
  const { task } = await createdResponse.json()
  let completed
  for (let attempt = 0; attempt < 100; attempt += 1) {
    completed = manager.get(task.id)
    if (completed.status === 'completed') break
    await delay(10)
  }
  assert.equal(completed.status, 'completed')
  assert.equal(completed.result, 'اكتمل الاختبار')

  const traversal = await fetch(`${base}/api/files/content?path=${encodeURIComponent('../secret.txt')}`)
  assert.equal(traversal.status, 400)
  const files = await fetch(`${base}/api/files`)
  assert.equal(files.status, 200)
  assert.deepEqual((await files.json()).entries, [])
})
