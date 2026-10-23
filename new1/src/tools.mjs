import { execFile } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_FILE_BYTES = 200_000
const MAX_SEARCH_FILE_BYTES = 1_000_000
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.cache'])
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'make_directory', 'run_tests'])

function isProtectedName(name) {
  return name === '.git' || name === '.env' || name.startsWith('.env.')
}

function assertInside(root, candidate) {
  const pathFromRoot = relative(root, candidate)
  if (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  ) {
    return
  }
  throw new Error('Path escapes the NEW1 workspace')
}

function buildCompactPreview(label, beforeText, afterText) {
  const beforeLines = beforeText ? beforeText.split(/\r?\n/).slice(0, 12) : []
  const afterLines = afterText ? afterText.split(/\r?\n/).slice(0, 16) : []
  const out = [`# ${label}`]
  for (const line of beforeLines) out.push(`- ${line}`)
  for (const line of afterLines) out.push(`+ ${line}`)
  return out.join('\n').slice(0, 2_400)
}

export class WorkspaceTools {
  constructor({ workspaceDir, allowCommands = false, commandTimeoutMs = 120_000 }) {
    this.workspaceDir = resolve(workspaceDir)
    this.allowCommands = allowCommands
    this.commandTimeoutMs = commandTimeoutMs
    mkdirSync(this.workspaceDir, { recursive: true })
  }

  isMutating(name) {
    return MUTATING_TOOLS.has(name)
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
    } else {
      // Check existing ancestor directories to prevent symlink escape on non-existent target
      let parent = dirname(candidate)
      while (!existsSync(parent) && parent !== dirname(parent)) {
        parent = dirname(parent)
      }
      if (existsSync(parent)) {
        if (lstatSync(parent).isSymbolicLink()) throw new Error('Symbolic links are not allowed')
        assertInside(root, realpathSync(parent))
      }
    }
    return candidate
  }

  describeMutation(name, args = {}) {
    try {
      if (name === 'write_file') {
        const target = this.safePath(args.path ?? '')
        const before = existsSync(target) && statSync(target).isFile() ? readFileSync(target, 'utf8') : ''
        return buildCompactPreview(
          `${before ? 'تحديث ملف' : 'إنشاء ملف جديد'}: ${args.path}`,
          before,
          String(args.content ?? '')
        )
      }
      if (name === 'edit_file') {
        return buildCompactPreview(
          `تعديل جزئي في الملف: ${args.path}`,
          String(args.old_text ?? args.oldText ?? ''),
          String(args.new_text ?? args.newText ?? '')
        )
      }
      if (name === 'delete_file') {
        return `# حذف ملف من مساحة العمل: ${args.path}`
      }
      if (name === 'make_directory') {
        return `# إنشاء مجلد داخل مساحة العمل: ${args.path}`
      }
      if (name === 'run_tests') {
        return '# تشغيل اختبارات المشروع المعزول: npm test'
      }
    } catch (error) {
      return `# ${name}: ${error.message}`
    }
    return `# ${name}`
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
            properties: {
              path: { type: 'string', description: 'Relative file path' }
            },
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
              path: { type: 'string', description: 'Relative file path' },
              content: { type: 'string', description: 'Full UTF-8 text content' }
            },
            required: ['path', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'edit_file',
          description: 'Replace an existing text snippet inside a UTF-8 workspace file.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative file path' },
              old_text: { type: 'string', description: 'Exact text snippet to find' },
              new_text: { type: 'string', description: 'Replacement text snippet' }
            },
            required: ['path', 'old_text', 'new_text']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'make_directory',
          description: 'Create a directory (and parents) inside the workspace.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative directory path' }
            },
            required: ['path']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'delete_file',
          description: 'Delete a single file inside the workspace.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative file path to delete' }
            },
            required: ['path']
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
      case 'edit_file':
        return this.editFile(args.path, args.old_text ?? args.oldText, args.new_text ?? args.newText)
      case 'make_directory':
        return this.makeDirectory(args.path)
      case 'delete_file':
        return this.deleteFile(args.path)
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
    if (!existsSync(path)) throw new Error('File does not exist')
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error('Not a file')
    if (stat.size > MAX_FILE_BYTES) throw new Error('File is larger than 200 KB')
    return readFileSync(path, 'utf8')
  }

  writeFile(inputPath, content) {
    if (typeof content !== 'string') throw new Error('File content must be a string')
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Content exceeds 200 KB')
    const path = this.safePath(inputPath, { forWrite: true })
    const existed = existsSync(path)
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, content, 'utf8')
    renameSync(temporaryPath, path)
    return JSON.stringify({
      ok: true,
      path: relative(this.workspaceDir, path).split(sep).join('/'),
      created: !existed,
      bytes: Buffer.byteLength(content)
    })
  }

  editFile(inputPath, oldText, newText) {
    if (typeof oldText !== 'string' || oldText.length === 0) {
      throw new Error('old_text must be a non-empty string')
    }
    if (typeof newText !== 'string') {
      throw new Error('new_text must be a string')
    }
    const path = this.safePath(inputPath)
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error('Target file does not exist')
    }
    const current = readFileSync(path, 'utf8')
    let updated
    if (current.includes(oldText)) {
      updated = current.replace(oldText, () => newText)
    } else {
      // Fallback: match normalized line endings (CRLF vs LF)
      const normalizedCurrent = current.replace(/\r\n/g, '\n')
      const normalizedOld = oldText.replace(/\r\n/g, '\n')
      if (!normalizedCurrent.includes(normalizedOld)) {
        throw new Error('old_text was not found in the file')
      }
      updated = normalizedCurrent.replace(normalizedOld, () => newText)
    }
    if (Buffer.byteLength(updated) > MAX_FILE_BYTES) {
      throw new Error('Edited content exceeds 200 KB')
    }
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, updated, 'utf8')
    renameSync(temporaryPath, path)
    return JSON.stringify({
      ok: true,
      path: relative(this.workspaceDir, path).split(sep).join('/'),
      bytes: Buffer.byteLength(updated)
    })
  }

  makeDirectory(inputPath) {
    const target = this.safePath(inputPath)
    mkdirSync(target, { recursive: true })
    assertInside(realpathSync(this.workspaceDir), realpathSync(target))
    return JSON.stringify({
      ok: true,
      path: relative(this.workspaceDir, target).split(sep).join('/')
    })
  }

  deleteFile(inputPath) {
    const target = this.safePath(inputPath)
    if (target === realpathSync(this.workspaceDir)) {
      throw new Error('Cannot delete the workspace root')
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new Error('File does not exist')
    }
    rmSync(target)
    return JSON.stringify({
      ok: true,
      deleted: relative(this.workspaceDir, target).split(sep).join('/')
    })
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
          resolvePromise(
            JSON.stringify({
              ok: !error,
              command: 'npm test',
              output: `${stdout}\n${stderr}`.trim().slice(0, 12_000)
            })
          )
        }
      )
    })
  }
}
