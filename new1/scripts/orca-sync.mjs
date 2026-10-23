#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { PROJECT_ROOT } from '../src/config.mjs'

const source = JSON.parse(readFileSync(join(PROJECT_ROOT, 'orca.source.json'), 'utf8'))
const target = resolve(PROJECT_ROOT, 'vendor', 'orca')

function git(args) {
  const result = spawnSync('git', args, { cwd: PROJECT_ROOT, stdio: 'inherit', shell: false })
  if (result.error || result.status !== 0) {
    console.error('Git failed. Check your connection and that Git is installed.')
    process.exit(result.status || 1)
  }
}

if (existsSync(join(target, '.git'))) {
  const current = spawnSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (current.stdout?.trim() === source.revision) {
    console.log(`Orca is already pinned at ${source.revision}`)
    process.exit(0)
  }
  console.log(`Updating Orca to ${source.revision}`)
  git(['-C', target, 'fetch', '--depth', '1', 'origin', source.revision])
  git(['-C', target, 'checkout', '--detach', 'FETCH_HEAD'])
} else {
  if (existsSync(target)) {
    console.error(`${target} exists but is not a Git checkout. Move it aside and retry.`)
    process.exit(1)
  }
  mkdirSync(dirname(target), { recursive: true })
  console.log(`Fetching ${source.name} at ${source.revision}`)
  git(['init', target])
  git(['-C', target, 'remote', 'add', 'origin', source.url])
  git(['-C', target, 'fetch', '--depth', '1', 'origin', source.revision])
  git(['-C', target, 'checkout', '--detach', 'FETCH_HEAD'])
}

console.log('\nOrca source is ready. Its own dependencies are separate from NEW1.')
console.log('Upstream uses Node.js 24 and pnpm; read vendor/orca/AGENTS.md before development.')
