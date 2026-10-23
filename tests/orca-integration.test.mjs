import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import {
  REPO_ROOT,
  buildAutomationCommands,
  buildWorkflowPlan,
  validateAll,
  validateOrcaPluginDir,
  validateOrcaYamlText,
  validateSubmodule
} from '../scripts/celia-orchestrator.mjs'
import activateCeliaPlugin from '../plugins/celia-ops/main.mjs'
import { createHubServer } from '../hub/server.mjs'

test('stablyai/orca is linked as a valid Git submodule at ./orca', () => {
  const sub = validateSubmodule(REPO_ROOT)
  assert.equal(sub.ok, true, `Submodule validation failed: ${sub.issues.join(', ')}`)
  assert.equal(sub.url, 'https://github.com/stablyai/orca.git')
  assert.match(sub.gitlinkSha, /^[0-9a-f]{40}$/)
})

test('repository configuration, orca.yaml, and celia-ops plugin pass full validation', () => {
  const result = validateAll(REPO_ROOT)
  assert.equal(
    result.ok,
    true,
    `Validation failed: ${JSON.stringify(result, null, 2)}`
  )
  assert.equal(result.plugin.pluginKey, 'elazamey.celia-ops')
  assert.equal(result.orcaYaml.parsed.setupAgentStartupPolicy, 'wait-for-setup')
  assert.equal(result.orcaYaml.parsed.defaultTabs[0].title, 'Agent')
  assert.equal(result.orcaYaml.parsed.defaultTabs[0].command, undefined)
})

test('orca.yaml validator rejects duplicate keys, invalid colors, and unsafe sharedDirectories', () => {
  const badYaml = `
scripts:
  setup: echo one
  setup: echo duplicate
setupAgentStartupPolicy: invalid-policy
defaultTabs:
  - title: BadColor
    color: not-a-hex
worktree:
  sharedDirectories:
    - ../escape
`
  const check = validateOrcaYamlText(badYaml)
  assert.equal(check.ok, false)
  assert.ok(check.issues.some((msg) => msg.includes('Duplicate YAML keys')))
  assert.ok(check.issues.some((msg) => msg.includes('Invalid setupAgentStartupPolicy')))
  assert.ok(check.issues.some((msg) => msg.includes('must be #RGB or #RRGGBB')))
  assert.ok(check.issues.some((msg) => msg.includes('Unsafe worktree.sharedDirectories')))
})

test('elazamey.celia-ops plugin worker registers commands and handles Orca events cleanly', async () => {
  const pluginValidation = validateOrcaPluginDir(join(REPO_ROOT, 'plugins', 'celia-ops'))
  assert.equal(pluginValidation.ok, true)

  const commands = new Map()
  const events = new Map()
  const storage = new Map()
  const notifications = []

  const mockOrca = {
    log: () => {},
    commands: {
      register(id, handler) {
        commands.set(id, handler)
      }
    },
    events: {
      on(eventName, handler) {
        events.set(eventName, handler)
      }
    },
    host: {
      async call(method, params) {
        if (method === 'storage.get') {
          return { value: storage.get(params.key) }
        }
        if (method === 'storage.set') {
          storage.set(params.key, params.value)
          return { ok: true }
        }
        if (method === 'workspace.readContext') {
          return {
            displayName: 'CELIA Storefront',
            branch: 'celia/test-branch',
            terminals: [{ id: 't1' }, { id: 't2' }]
          }
        }
        if (method === 'notifications.show') {
          notifications.push(params)
          return { delivered: true }
        }
        throw new Error(`Unexpected host call: ${method}`)
      }
    }
  }

  activateCeliaPlugin(mockOrca)

  assert.ok(commands.has('celia.workspace-summary'))
  assert.ok(commands.has('celia.reset-metrics'))
  assert.ok(events.has('worktree.created'))
  assert.ok(events.has('agent.status.changed'))

  await events.get('worktree.created')({
    worktreeId: 'wt-1',
    branch: 'celia/seasonal-launch',
    path: '/tmp/wt-1'
  })
  await events.get('agent.status.changed')({
    worktreeId: 'wt-1',
    paneKey: 'tab-1',
    state: 'done',
    receivedAt: Date.now(),
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: Date.now() - 1000 }
  })

  const summary = await commands.get('celia.workspace-summary')()
  assert.equal(summary.activeBranch, 'celia/test-branch')
  assert.equal(summary.openTerminals, 2)
  assert.equal(summary.metrics.worktreesCreated, 1)
  assert.equal(summary.metrics.agentCompletions, 1)
  assert.ok(notifications.length >= 3)

  await commands.get('celia.reset-metrics')()
  const resetSummary = await commands.get('celia.workspace-summary')()
  assert.equal(resetSummary.metrics.worktreesCreated, 0)
  assert.equal(resetSummary.metrics.agentCompletions, 0)
})

test('workflow planner and scheduled automations produce valid Orca commands', () => {
  const plan = buildWorkflowPlan('seasonal-collection-launch')
  assert.equal(plan.agentCount, 4)
  assert.ok(plan.steps.every((s) => s.gitWorktreeCommand.startsWith('git worktree add -b ')))

  const automations = buildAutomationCommands()
  assert.ok(automations.length >= 2)
  assert.ok(automations.every((a) => a.cliCommand.includes('orca automations create')))
})

test('CELIA × Orca Hub HTTP server serves health, ecosystem, custom plans, and plugin panel', async () => {
  const server = createHubServer(REPO_ROOT)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  try {
    const healthRes = await fetch(`${base}/api/health`)
    assert.equal(healthRes.status, 200)
    const health = await healthRes.json()
    assert.equal(health.status, 'ok')
    assert.equal(health.pluginKey, 'elazamey.celia-ops')

    const ecoRes = await fetch(`${base}/api/ecosystem`)
    assert.equal(ecoRes.status, 200)
    const eco = await ecoRes.json()
    assert.equal(eco.brand.name, 'CELIA')
    assert.ok(eco.services.length >= 6)

    const customRes = await fetch(`${base}/api/plan/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'إضافة عرض ثلاثي الأبعاد لفساتين السهرة' })
    })
    assert.equal(customRes.status, 200)
    const customPlan = await customRes.json()
    assert.equal(customPlan.agentCount, 3)

    const panelRes = await fetch(`${base}/plugin-preview/panel.html`)
    assert.equal(panelRes.status, 200)
    const panelHtml = await panelRes.text()
    assert.ok(panelHtml.includes('CELIA STUDIO'))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
