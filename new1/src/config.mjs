import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function loadEnvFile(path) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match || process.env[match[1]] !== undefined) continue
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

loadEnvFile(join(PROJECT_ROOT, '.env'))

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeOllamaUrl(value) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`
  return new URL(withScheme).toString().replace(/\/$/, '')
}

export function loadConfig(overrides = {}) {
  const rootDir = resolve(overrides.rootDir ?? PROJECT_ROOT)
  const ollamaUrl = normalizeOllamaUrl(
    overrides.ollamaUrl ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
  )

  const defaultOrcaCandidates = [
    join(rootDir, 'vendor', 'orca'),
    join(rootDir, '.cache', 'orca'),
    resolve(rootDir, '..', '.cache', 'orca'),
    resolve(rootDir, '..', 'orca')
  ]
  const resolvedDefaultOrca =
    defaultOrcaCandidates.find((dir) => existsSync(join(dir, 'package.json'))) ??
    join(rootDir, 'vendor', 'orca')

  return {
    rootDir,
    publicDir: resolve(overrides.publicDir ?? join(rootDir, 'public')),
    dataDir: resolve(overrides.dataDir ?? process.env.NEW1_DATA_DIR ?? join(rootDir, '.data')),
    workspaceDir: resolve(
      overrides.workspaceDir ?? process.env.NEW1_WORKSPACE_DIR ?? join(rootDir, 'workspace')
    ),
    orcaDir: resolve(overrides.orcaDir ?? resolvedDefaultOrca),
    host: overrides.host ?? process.env.HOST ?? '0.0.0.0',
    port: positiveInteger(overrides.port ?? process.env.PORT, 3000),
    ollamaUrl,
    model: overrides.model ?? process.env.OLLAMA_MODEL ?? 'qwen3:8b',
    requestTimeoutMs: positiveInteger(
      overrides.requestTimeoutMs ?? process.env.OLLAMA_TIMEOUT_MS,
      120_000
    ),
    maxSteps: positiveInteger(overrides.maxSteps ?? process.env.NEW1_MAX_STEPS, 10),
    maxConcurrency: positiveInteger(
      overrides.maxConcurrency ?? process.env.NEW1_MAX_CONCURRENCY,
      2
    ),
    commandTimeoutMs: positiveInteger(
      overrides.commandTimeoutMs ?? process.env.NEW1_COMMAND_TIMEOUT_MS,
      120_000
    )
  }
}
