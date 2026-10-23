import { execFile } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_FILE_BYTES = 200_000
const MAX_SEARCH_FILE_BYTES = 1_000_000
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.cache'])

function isProtectedName(name) {
  return name === '.git' || name === '.env' || name.startsWith('.env.')
}

function assertInside(root, candidate) {
  const pathFromRoot = relative(root, candidate)
  if (pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))) {
    return
  }
  throw new Error('Path escapes the NEW1 workspace')
}

export class WorkspaceTools {
  constructor({ workspaceDir, allowCommands = false, commandTimeoutMs = 120_000 }) {
    this.workspaceDir = resolve(workspaceDir)
    this.allowCommands = allowCommands
    this.commandTimeoutMs = commandTimeoutMs
    mkdirSync(this.workspaceDir, { recursive: true })
  }

  safePath(input = '.', { forWrite = false } = {}) {
    if (typeof input !== 'string' || input.includes('\0') || input.length > 500) {
      throw new Error('Invalid workspace path')
    }
    if (isAbsolute(input) || win32.isAbsolute(input)) {
      throw new Error('Use a relative path inside the workspace')
    }
    if (input.split(/[\\/]/).some(isProtectedName)) {
      throw new Error('Git metadata and environment files are protected')
    }

    const root = realpathSync(this.workspaceDir)
    const candidate = resolve(this.workspaceDir, input || '.')
    assertInside(root, candidate)

    if (existsSync(candidate)) {
      if (lstatSync(candidate).isSymbolicLink()) throw new Error('Symbolic links are not allowed')
      assertInside(root, realpathSync(candidate))
    } else if (forWrite) {
      mkdirSync(dirname(candidate), { recursive: true })
      assertInside(root, realpathSync(dirname(candidate)))
    }
    return candidate
  }

  definitions() {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'list_files',
          description: 'List files and directories inside the isolated workspace.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative directory path, or .' },
              recursive: { type: 'boolean', description: 'Include nested entries' }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a UTF-8 text file inside the workspace.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Create or replace a UTF-8 text file inside the workspace.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' }
            },
            required: ['path', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_files',
          description: 'Search text files for a case-insensitive literal query.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              path: { type: 'string', description: 'Relative directory path, or .' }
            },
            required: ['query']
          }
        }
      }
    ]

    if (this.allowCommands) {
      tools.push({
        type: 'function',
        function: {
          name: 'run_tests',
          description: 'Run npm test in the workspace. This is the only command available.',
          parameters: { type: 'object', properties: {} }
        }
      })
    }
    return tools
  }

  async execute(name, args = {}) {
    switch (name) {
      case 'list_files':
        return this.listFiles(args.path ?? '.', Boolean(args.recursive))
      case 'read_file':
        return this.readFile(args.path)
      case 'write_file':
        return this.writeFile(args.path, args.content)
      case 'search_files':
        return this.searchFiles(args.query, args.path ?? '.')
      case 'run_tests':
        if (!this.allowCommands) throw new Error('Test execution was not enabled for this task')
        return this.runTests()
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  }

  listFiles(inputPath, recursive) {
    const start = this.safePath(inputPath)
    const entries = []
    let truncated = false

    const walk = (directory, depth) => {
      if (entries.length >= 300) {
        truncated = true
        return
      }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (isProtectedName(entry.name) || SKIPPED_DIRECTORIES.has(entry.name)) continue
        if (entries.length >= 300) {
          truncated = true
          break
        }
        const absolute = resolve(directory, entry.name)
        assertInside(realpathSync(this.workspaceDir), realpathSync(absolute))
        const item = {
          path: relative(this.workspaceDir, absolute).split(sep).join('/'),
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
        }
        if (item.type === 'file') item.size = statSync(absolute).size
        entries.push(item)
        if (recursive && entry.isDirectory() && depth < 8) walk(absolute, depth + 1)
      }
    }

    if (!statSync(start).isDirectory()) throw new Error('Not a directory')
    walk(start, 0)
    return JSON.stringify({ entries, truncated }, null, 2)
  }

  readFile(inputPath) {
    const path = this.safePath(inputPath)
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error('Not a file')
    if (stat.size > MAX_FILE_BYTES) throw new Error('File is larger than 200 KB')
    return readFileSync(path, 'utf8')
  }

  writeFile(inputPath, content) {
    if (typeof content !== 'string') throw new Error('File content must be a string')
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Content exceeds 200 KB')
    const path = this.safePath(inputPath, { forWrite: true })
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, content, 'utf8')
    renameSync(temporaryPath, path)
    return JSON.stringify({ ok: true, path: relative(this.workspaceDir, path), bytes: Buffer.byteLength(content) })
  }

  searchFiles(query, inputPath) {
    if (typeof query !== 'string' || query.trim().length < 2) {
      throw new Error('Search query must contain at least two characters')
    }
    const start = this.safePath(inputPath)
    const results = []
    const needle = query.toLocaleLowerCase()

    const walk = (path) => {
      if (results.length >= 50) return
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (isProtectedName(entry.name) || SKIPPED_DIRECTORIES.has(entry.name)) continue
        const absolute = resolve(path, entry.name)
        if (entry.isDirectory()) {
          walk(absolute)
          continue
        }
        if (!entry.isFile() || statSync(absolute).size > MAX_SEARCH_FILE_BYTES) continue
        const content = readFileSync(absolute, 'utf8')
        if (content.includes('\0')) continue
        content.split(/\r?\n/).forEach((line, index) => {
          if (results.length < 50 && line.toLocaleLowerCase().includes(needle)) {
            results.push({
              path: relative(this.workspaceDir, absolute).split(sep).join('/'),
              line: index + 1,
              text: line.trim().slice(0, 500)
            })
          }
        })
      }
    }

    if (!statSync(start).isDirectory()) throw new Error('Not a directory')
    walk(start)
    return JSON.stringify({ results, truncated: results.length >= 50 }, null, 2)
  }

  runTests() {
    if (!existsSync(resolve(this.workspaceDir, 'package.json'))) {
      throw new Error('No package.json exists in the workspace')
    }
    const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    return new Promise((resolvePromise) => {
      execFile(
        executable,
        ['test'],
        {
          cwd: this.workspaceDir,
          shell: false,
          timeout: this.commandTimeoutMs,
          maxBuffer: 1_000_000,
          windowsHide: true,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            CI: '1',
            NODE_ENV: 'test'
          }
        },
        (error, stdout, stderr) => {
          resolvePromise(JSON.stringify({
            ok: !error,
            command: 'npm test',
            output: `${stdout}${stderr}`.slice(-20_000),
            error: error?.message ?? null
          }))
        }
      )
    })
  }
}
