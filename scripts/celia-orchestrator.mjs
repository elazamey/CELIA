#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(__dirname, '..')

const MAX_ORCA_YAML_BYTES = 262_144
const MAX_ORCA_YAML_FIELD_BYTES = 65_536
const TAB_COLOR_RE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/
const KEBAB_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COMMAND_ID_RE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const ENGINE_RANGE_RE = /^>=\d+\.\d+\.\d+$/

const ALLOWED_CONTRIBUTES_KEYS = new Set([
  'panels',
  'commands',
  'events',
  'languagePacks',
  'keybindings',
  'vmRecipes',
  'agents'
])

const ALLOWED_EVENTS = new Set([
  'worktree.created',
  'worktree.removed',
  'agent.status.changed'
])

const ALLOWED_CAPABILITIES = new Set([
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage',
  'secrets',
  'events:subscribe',
  'settings:own'
])

export function loadEcosystem(rootDir = REPO_ROOT) {
  const filePath = join(rootDir, 'config', 'celia-ecosystem.json')
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

export function validateSubmodule(rootDir = REPO_ROOT) {
  const issues = []
  const gitmodulesPath = join(rootDir, '.gitmodules')
  if (!existsSync(gitmodulesPath)) {
    return { ok: false, issues: ['Missing .gitmodules at repository root'] }
  }

  const gitmodulesText = readFileSync(gitmodulesPath, 'utf8')
  if (!gitmodulesText.includes('[submodule "orca"]')) {
    issues.push('.gitmodules is missing [submodule "orca"] section')
  }
  if (!gitmodulesText.includes('https://github.com/stablyai/orca.git')) {
    issues.push('.gitmodules does not point to https://github.com/stablyai/orca.git')
  }

  let gitlinkSha = null
  try {
    const lsFiles = execFileSync('git', ['ls-files', '--stage', 'orca'], {
      cwd: rootDir,
      encoding: 'utf8'
    }).trim()
    const match = lsFiles.match(/^160000\s+([0-9a-f]{40})\s+\d+\s+orca$/m)
    if (!match) {
      issues.push('orca is not registered as a 160000 gitlink entry in the Git index')
    } else {
      gitlinkSha = match[1]
    }
  } catch (error) {
    issues.push(`Failed to inspect git index for orca submodule: ${error.message}`)
  }

  return {
    ok: issues.length === 0,
    submodulePath: 'orca',
    url: 'https://github.com/stablyai/orca.git',
    gitlinkSha,
    initializedOnDisk: existsSync(join(rootDir, 'orca', 'package.json')),
    issues
  }
}

export function parseSimpleOrcaYaml(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const seenKeysByScope = new Map()
  const parsed = {
    scripts: {},
    setupAgentStartupPolicy: undefined,
    issueCommand: undefined,
    defaultTabs: [],
    worktree: { sharedDirectories: [] }
  }
  const duplicateKeys = []

  const registerKey = (scope, key) => {
    if (!seenKeysByScope.has(scope)) {
      seenKeysByScope.set(scope, new Set())
    }
    const bucket = seenKeysByScope.get(scope)
    if (bucket.has(key)) {
      duplicateKeys.push(`${scope}.${key}`)
    }
    bucket.add(key)
  }

  let section = null
  let currentTab = null
  let blockTarget = null
  let blockIndent = 0
  let blockLines = []

  const flushBlock = () => {
    if (!blockTarget) return
    const value = blockLines.join('\n').trim()
    if (blockTarget === 'scripts.setup') parsed.scripts.setup = value
    if (blockTarget === 'scripts.archive') parsed.scripts.archive = value
    if (blockTarget === 'issueCommand') parsed.issueCommand = value
    blockTarget = null
    blockLines = []
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    const indent = rawLine.match(/^ */)[0].length

    if (blockTarget) {
      if (trimmed === '' || indent >= blockIndent) {
        blockLines.push(rawLine.slice(Math.min(rawLine.length, blockIndent)))
        continue
      }
      flushBlock()
    }

    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    if (indent === 0) {
      currentTab = null
      const match = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
      if (!match) continue
      const [, key, rest] = match
      registerKey('root', key)
      section = key
      if (key === 'setupAgentStartupPolicy' && rest) {
        parsed.setupAgentStartupPolicy = rest.replace(/^['"]|['"]$/g, '').trim()
      } else if (key === 'issueCommand' && rest === '|') {
        blockTarget = 'issueCommand'
        blockIndent = 2
      } else if (key === 'issueCommand' && rest) {
        parsed.issueCommand = rest.replace(/^['"]|['"]$/g, '').trim()
      }
      continue
    }

    if (section === 'scripts' && indent === 2) {
      const match = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
      if (!match) continue
      const [, key, rest] = match
      registerKey('scripts', key)
      if (rest === '|') {
        blockTarget = `scripts.${key}`
        blockIndent = 4
      } else {
        parsed.scripts[key] = rest.replace(/^['"]|['"]$/g, '').trim()
      }
      continue
    }

    if (section === 'defaultTabs') {
      if (trimmed.startsWith('- ')) {
        currentTab = {}
        parsed.defaultTabs.push(currentTab)
        const inline = trimmed.slice(2).trim()
        const kv = inline.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
        if (kv) {
          currentTab[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim()
        }
      } else if (currentTab) {
        const kv = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
        if (kv) {
          currentTab[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim()
        }
      }
      continue
    }

    if (section === 'worktree') {
      if (indent === 2 && trimmed.startsWith('sharedDirectories:')) {
        registerKey('worktree', 'sharedDirectories')
      } else if (trimmed.startsWith('- ')) {
        parsed.worktree.sharedDirectories.push(
          trimmed.slice(2).replace(/^['"]|['"]$/g, '').trim()
        )
      }
    }
  }

  flushBlock()
  return { parsed, duplicateKeys }
}

export function validateOrcaYamlText(text) {
  const issues = []
  const byteLength = Buffer.byteLength(text, 'utf8')
  if (byteLength > MAX_ORCA_YAML_BYTES || text.length > MAX_ORCA_YAML_BYTES) {
    issues.push(`orca.yaml exceeds 256 KiB limit (${byteLength} bytes)`)
  }

  const { parsed, duplicateKeys } = parseSimpleOrcaYaml(text)
  if (duplicateKeys.length > 0) {
    issues.push(`Duplicate YAML keys rejected by Orca: ${duplicateKeys.join(', ')}`)
  }

  for (const [label, value] of [
    ['scripts.setup', parsed.scripts.setup],
    ['scripts.archive', parsed.scripts.archive],
    ['issueCommand', parsed.issueCommand]
  ]) {
    if (value && Buffer.byteLength(value, 'utf8') > MAX_ORCA_YAML_FIELD_BYTES) {
      issues.push(`${label} exceeds 64 KiB field limit`)
    }
  }

  if (
    parsed.setupAgentStartupPolicy !== undefined &&
    parsed.setupAgentStartupPolicy !== 'start-immediately' &&
    parsed.setupAgentStartupPolicy !== 'wait-for-setup'
  ) {
    issues.push(
      `Invalid setupAgentStartupPolicy "${parsed.setupAgentStartupPolicy}" (must be start-immediately or wait-for-setup)`
    )
  }

  if (parsed.defaultTabs.length > 256) {
    issues.push('defaultTabs exceeds 256 entries limit')
  }

  for (const [index, tab] of parsed.defaultTabs.entries()) {
    if (!tab.title && !tab.command && !tab.color) {
      issues.push(`defaultTabs[${index}] must define at least one of title, command, or color`)
    }
    if (tab.color && !TAB_COLOR_RE.test(tab.color)) {
      issues.push(`defaultTabs[${index}].color "${tab.color}" must be #RGB or #RRGGBB`)
    }
  }

  for (const dir of parsed.worktree.sharedDirectories) {
    const segments = dir.split(/[\\/]/)
    if (
      !dir ||
      dir.startsWith('/') ||
      /^[a-zA-Z]:/.test(dir) ||
      segments.includes('..') ||
      segments.includes('.') ||
      segments.includes('.git')
    ) {
      issues.push(`Unsafe worktree.sharedDirectories path "${dir}"`)
    }
  }

  return {
    ok: issues.length === 0,
    parsed,
    issues
  }
}

function assertContainedRegularFile(pluginRootDir, relPath, label, issues) {
  if (!relPath || typeof relPath !== 'string') {
    issues.push(`${label} must be a non-empty relative path`)
    return
  }
  if (isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
    issues.push(`${label} "${relPath}" must stay inside plugin root`)
    return
  }
  const target = resolve(pluginRootDir, relPath)
  if (!existsSync(target)) {
    issues.push(`${label} "${relPath}" does not exist`)
    return
  }
  const rootReal = realpathSync(pluginRootDir)
  const targetReal = realpathSync(target)
  const rel = relative(rootReal, targetReal)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    issues.push(`${label} "${relPath}" resolves outside plugin directory`)
    return
  }
  if (!statSync(targetReal).isFile()) {
    issues.push(`${label} "${relPath}" is not a regular file`)
  }
}

export function validateOrcaPluginDir(pluginDir) {
  const issues = []
  const manifestPath = join(pluginDir, 'orca-plugin.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, issues: [`Missing orca-plugin.json in ${pluginDir}`] }
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { ok: false, issues: [`Invalid JSON in orca-plugin.json: ${error.message}`] }
  }

  if (manifest.manifestVersion !== 1) {
    issues.push('manifestVersion must be 1')
  }
  if (manifest.pluginApi !== 1) {
    issues.push('pluginApi must be 1')
  }
  if (!KEBAB_ID_RE.test(manifest.id || '')) {
    issues.push(`Plugin id "${manifest.id}" must be kebab-case`)
  }
  if (!KEBAB_ID_RE.test(manifest.publisher || '')) {
    issues.push(`Plugin publisher "${manifest.publisher}" must be kebab-case`)
  }
  if (!SEMVER_RE.test(manifest.version || '')) {
    issues.push(`Plugin version "${manifest.version}" must be valid semver`)
  }
  if (!ENGINE_RANGE_RE.test(manifest.engines?.orca || '')) {
    issues.push(`engines.orca "${manifest.engines?.orca}" must match ">=x.y.z"`)
  }

  const contributes = manifest.contributes ?? {}
  for (const key of Object.keys(contributes)) {
    if (!ALLOWED_CONTRIBUTES_KEYS.has(key)) {
      issues.push(`Unknown contributes key "${key}" rejected by strict Orca schema`)
    }
  }

  const panels = Array.isArray(contributes.panels) ? contributes.panels : []
  const commands = Array.isArray(contributes.commands) ? contributes.commands : []
  const events = Array.isArray(contributes.events) ? contributes.events : []
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : []

  for (const panel of panels) {
    if (!KEBAB_ID_RE.test(panel.id || '')) {
      issues.push(`Panel id "${panel.id}" must be kebab-case`)
    }
    assertContainedRegularFile(pluginDir, panel.entry, `panel "${panel.id}" entry`, issues)
  }

  for (const command of commands) {
    if (!COMMAND_ID_RE.test(command.id || '')) {
      issues.push(`Command id "${command.id}" is invalid`)
    }
  }

  for (const eventEntry of events) {
    if (!ALLOWED_EVENTS.has(eventEntry.on)) {
      issues.push(`Unsupported plugin event "${eventEntry.on}"`)
    }
  }

  const capabilitySet = new Set()
  for (const cap of capabilities) {
    const keys = Object.keys(cap || {})
    if (keys.length !== 1 || keys[0] !== 'kind' || !ALLOWED_CAPABILITIES.has(cap.kind)) {
      issues.push(`Invalid capability entry: ${JSON.stringify(cap)}`)
    } else {
      capabilitySet.add(cap.kind)
    }
  }

  if (manifest.main) {
    assertContainedRegularFile(pluginDir, manifest.main, 'worker main', issues)
  } else if (commands.some((c) => !c.action) || events.length > 0) {
    issues.push('main worker file is required when worker commands or events are declared')
  }

  if (events.length > 0 && !capabilitySet.has('events:subscribe')) {
    issues.push('events:subscribe capability is required when contributes.events is non-empty')
  }

  return {
    ok: issues.length === 0,
    pluginKey:
      manifest.publisher && manifest.id ? `${manifest.publisher}.${manifest.id}` : null,
    manifest,
    issues
  }
}

export function validateAll(rootDir = REPO_ROOT) {
  const orcaYamlPath = join(rootDir, 'orca.yaml')
  const worktreeIncludePath = join(rootDir, '.worktreeinclude')
  const skillPath = join(
    rootDir,
    '.agents',
    'skills',
    'celia-orca-orchestrator',
    'SKILL.md'
  )
  const pluginDir = join(rootDir, 'plugins', 'celia-ops')

  const submodule = validateSubmodule(rootDir)
  const orcaYaml = existsSync(orcaYamlPath)
    ? validateOrcaYamlText(readFileSync(orcaYamlPath, 'utf8'))
    : { ok: false, issues: ['Missing orca.yaml at repository root'] }
  const plugin = validateOrcaPluginDir(pluginDir)

  const extraIssues = []
  if (!existsSync(worktreeIncludePath)) {
    extraIssues.push('Missing .worktreeinclude at repository root')
  }
  if (!existsSync(skillPath)) {
    extraIssues.push('Missing .agents/skills/celia-orca-orchestrator/SKILL.md')
  }

  const ok = submodule.ok && orcaYaml.ok && plugin.ok && extraIssues.length === 0
  return {
    ok,
    submodule,
    orcaYaml,
    plugin,
    extraIssues
  }
}

export function buildWorkflowPlan(workflowId, rootDir = REPO_ROOT) {
  const ecosystem = loadEcosystem(rootDir)
  const workflow =
    ecosystem.workflows.find((w) => w.id === workflowId) ?? ecosystem.workflows[0]
  if (!workflow) {
    throw new Error(`No workflow found for id "${workflowId}"`)
  }

  const steps = workflow.agents.map((item, idx) => {
    const branchName = `celia/${workflow.id}/${item.worktree.replace(/^wt\//, '')}`
    const worktreePath = `../CELIA-${item.worktree.replace(/^wt\//, '')}`
    return {
      order: idx + 1,
      worktree: item.worktree,
      branch: branchName,
      worktreePath,
      agent: item.agent,
      focusAr: item.focusAr,
      promptAr: item.promptAr,
      gitWorktreeCommand: `git worktree add -b ${branchName} ${worktreePath} HEAD`,
      orcaOrchestrationHint: `orca skills get orchestration && # Dispatch ${item.agent} in ${item.worktree}`
    }
  })

  return {
    workflowId: workflow.id,
    titleAr: workflow.titleAr,
    titleEn: workflow.titleEn,
    summaryAr: workflow.summaryAr,
    agentCount: steps.length,
    steps
  }
}

export function buildAutomationCommands(rootDir = REPO_ROOT) {
  const ecosystem = loadEcosystem(rootDir)
  return ecosystem.automations.map((auto) => {
    const cmd = [
      'orca automations create',
      `--name ${JSON.stringify(auto.name)}`,
      `--trigger ${JSON.stringify(auto.trigger)}`,
      `--time ${JSON.stringify(auto.time)}`,
      `--timezone ${JSON.stringify(auto.timezone)}`,
      `--provider ${auto.provider}`,
      `--precheck ${JSON.stringify(auto.precheck)}`,
      `--prompt ${JSON.stringify(auto.prompt)}`,
      '--repo CELIA',
      '--disabled',
      '--json'
    ].join(' \\\n  ')

    return {
      ...auto,
      cliCommand: cmd
    }
  })
}

export function getSystemSnapshot(rootDir = REPO_ROOT) {
  const ecosystem = loadEcosystem(rootDir)
  const validation = validateAll(rootDir)
  const automations = buildAutomationCommands(rootDir)
  const plans = ecosystem.workflows.map((w) => buildWorkflowPlan(w.id, rootDir))
  return {
    timestamp: new Date().toISOString(),
    brand: ecosystem.brand,
    orca: {
      ...ecosystem.orca,
      submoduleStatus: validation.submodule
    },
    validation: {
      ok: validation.ok,
      submoduleOk: validation.submodule.ok,
      orcaYamlOk: validation.orcaYaml.ok,
      pluginOk: validation.plugin.ok,
      pluginKey: validation.plugin.pluginKey,
      issues: [
        ...validation.submodule.issues,
        ...validation.orcaYaml.issues,
        ...validation.plugin.issues,
        ...validation.extraIssues
      ]
    },
    services: ecosystem.services,
    plans,
    automations
  }
}

function runCli() {
  const args = process.argv.slice(2)
  const jsonFlag = args.includes('--json')
  const positional = args.filter((a) => !a.startsWith('--'))
  const command = positional[0] || 'status'

  if (command === 'validate') {
    const result = validateAll()
    if (jsonFlag) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`[validate] Submodule (orca @ ${result.submodule.gitlinkSha?.slice(0, 8) ?? 'missing'}): ${result.submodule.ok ? 'PASS' : 'FAIL'}`)
      console.log(`[validate] orca.yaml configuration: ${result.orcaYaml.ok ? 'PASS' : 'FAIL'}`)
      console.log(`[validate] Orca Plugin (${result.plugin.pluginKey ?? 'unknown'}): ${result.plugin.ok ? 'PASS' : 'FAIL'}`)
      if (!result.ok) {
        console.error('Validation issues:', [
          ...result.submodule.issues,
          ...result.orcaYaml.issues,
          ...result.plugin.issues,
          ...result.extraIssues
        ])
      } else {
        console.log('[validate] All CELIA × Orca checks passed.')
      }
    }
    process.exit(result.ok ? 0 : 1)
  }

  if (command === 'plan') {
    const plan = buildWorkflowPlan(positional[1])
    if (jsonFlag) {
      console.log(JSON.stringify(plan, null, 2))
    } else {
      console.log(`\n=== ${plan.titleAr} (${plan.agentCount} Parallel Orca Worktrees) ===`)
      console.log(`${plan.summaryAr}\n`)
      for (const step of plan.steps) {
        console.log(`[#${step.order}] ${step.worktree} (${step.agent.toUpperCase()}) -> ${step.focusAr}`)
        console.log(`    Branch : ${step.branch}`)
        console.log(`    Setup  : ${step.gitWorktreeCommand}`)
        console.log(`    Prompt : ${step.promptAr}\n`)
      }
    }
    return
  }

  if (command === 'automations') {
    const items = buildAutomationCommands()
    if (jsonFlag) {
      console.log(JSON.stringify(items, null, 2))
    } else {
      console.log('\n=== CELIA Scheduled Orca Automations ===\n')
      for (const item of items) {
        console.log(`• ${item.name} (${item.trigger} @ ${item.time} ${item.timezone})`)
        console.log(`${item.cliCommand}\n`)
      }
    }
    return
  }

  const snapshot = getSystemSnapshot()
  if (jsonFlag) {
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }

  console.log(`\n=== ${snapshot.brand.name} — ${snapshot.brand.taglineAr} ===`)
  console.log(`Orca Submodule : ${snapshot.orca.repository} @ ${snapshot.orca.submoduleStatus.gitlinkSha?.slice(0, 12)}`)
  console.log(`Orca Plugin    : ${snapshot.validation.pluginKey} (${snapshot.validation.ok ? 'VALID' : 'ISSUES FOUND'})`)
  console.log('\nRegistered CELIA Services:')
  for (const svc of snapshot.services) {
    const portInfo = svc.defaultPort ? `:${svc.defaultPort}` : 'library/protocol'
    console.log(`  - [${svc.id}] ${svc.nameAr} (${portInfo}) -> ${svc.repo}`)
  }
  console.log('\nAvailable Parallel Workflows (run: npm run plan -- <id>):')
  for (const p of snapshot.plans) {
    console.log(`  - ${p.workflowId}: ${p.titleAr} (${p.agentCount} agents)`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli()
}
