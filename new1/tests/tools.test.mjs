import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceTools } from '../src/tools.mjs'

function fixture(t) {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'new1-tools-'))
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }))
  return { workspaceDir, tools: new WorkspaceTools({ workspaceDir }) }
}

test('workspace tools write, read, list, and search real files', async (t) => {
  const { workspaceDir, tools } = fixture(t)
  const writeResult = await tools.execute('write_file', { path: 'notes/todo.txt', content: 'ابنِ وكيلًا محليًا\nFREE LOCAL AGENT' })
  assert.equal(JSON.parse(writeResult).ok, true)
  assert.equal(readFileSync(join(workspaceDir, 'notes', 'todo.txt'), 'utf8'), 'ابنِ وكيلًا محليًا\nFREE LOCAL AGENT')
  assert.equal(await tools.execute('read_file', { path: 'notes/todo.txt' }), 'ابنِ وكيلًا محليًا\nFREE LOCAL AGENT')

  const listing = JSON.parse(await tools.execute('list_files', { path: '.', recursive: true }))
  assert.ok(listing.entries.some((entry) => entry.path === 'notes/todo.txt'))

  const search = JSON.parse(await tools.execute('search_files', { query: 'local', path: '.' }))
  assert.equal(search.results.length, 1)
  assert.equal(search.results[0].line, 2)
})

test('workspace tools reject traversal, absolute paths, and secrets', async (t) => {
  const { tools } = fixture(t)
  await assert.rejects(tools.execute('write_file', { path: '../escape.txt', content: 'no' }), /escapes/)
  await assert.rejects(tools.execute('read_file', { path: '/etc/passwd' }), /relative/)
  await assert.rejects(tools.execute('write_file', { path: '.env', content: 'SECRET=x' }), /protected/)
  await assert.rejects(tools.execute('write_file', { path: 'repo/.git/config', content: 'no' }), /protected/)
  await assert.rejects(tools.execute('run_tests', {}), /not enabled/)
})

test('test tool is exposed only after explicit opt-in', (t) => {
  const { workspaceDir, tools } = fixture(t)
  assert.ok(!tools.definitions().some((tool) => tool.function.name === 'run_tests'))
  const enabled = new WorkspaceTools({ workspaceDir, allowCommands: true })
  assert.ok(enabled.definitions().some((tool) => tool.function.name === 'run_tests'))
})
