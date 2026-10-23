#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, PROJECT_ROOT } from '../src/config.mjs'

const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  console.error(`NEW1 needs Node.js 22 or newer; current version is ${process.version}`)
  process.exit(1)
}

const config = loadConfig()
mkdirSync(config.dataDir, { recursive: true })
mkdirSync(config.workspaceDir, { recursive: true })
const orca = JSON.parse(readFileSync(join(PROJECT_ROOT, 'orca.source.json'), 'utf8'))

console.log('NEW1 setup check')
console.log(`  Node.js    ${process.version} ✓`)
console.log(`  Data       ${config.dataDir}`)
console.log(`  Workspace  ${config.workspaceDir}`)
console.log(`  Provider   ${config.ollamaUrl}`)
console.log(`  Model      ${config.model}`)
console.log(`  Orca       ${orca.url} @ ${orca.revision.slice(0, 12)}`)
console.log('\nNext steps:')
console.log(`  ollama pull ${config.model}`)
console.log('  ollama serve')
console.log('  npm start')
console.log('\nOptional Orca source: npm run orca:init')
