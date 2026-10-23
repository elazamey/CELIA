#!/usr/bin/env node
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { PROJECT_ROOT } from '../src/config.mjs'

const EXPECTED_SHA256 = '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db'
const MODEL_FILENAME = 'qwen2.5-0.5b-instruct-q4_k_m.gguf'
const MODEL_TAG = 'qwen2.5:0.5b-instruct'
const CHUNK_SOURCE_REPO = 'https://github.com/rtynbirf/singulyar-llm.git'

function resolveCacheRoot() {
  const parentCache = resolve(PROJECT_ROOT, '..', '.cache')
  if (existsSync(join(parentCache, 'models', MODEL_FILENAME))) return parentCache
  return resolve(PROJECT_ROOT, '.cache')
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export async function ensureEmbeddedRuntime() {
  const cacheRoot = resolveCacheRoot()
  const modelsDir = join(cacheRoot, 'models')
  const runtimeDir = join(cacheRoot, 'runtime')
  const modelPath = join(modelsDir, MODEL_FILENAME)
  const llamaEntry = join(runtimeDir, 'node_modules', 'node-llama-cpp', 'dist', 'index.js')

  mkdirSync(modelsDir, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })

  if (existsSync(modelPath)) {
    const digest = await sha256File(modelPath)
    if (digest !== EXPECTED_SHA256) {
      rmSync(modelPath, { force: true })
    }
  }

  if (!existsSync(modelPath)) {
    const tempClone = join(cacheRoot, `tmp-model-${process.pid}`)
    rmSync(tempClone, { recursive: true, force: true })
    console.log(`[NEW1 Local Engine] Downloading Apache-2.0 ${MODEL_TAG} GGUF weights…`)
    execFileSync('git', ['clone', '--depth', '1', CHUNK_SOURCE_REPO, tempClone], {
      stdio: 'inherit',
      shell: false
    })
    try {
      const partsDir = join(tempClone, 'MODELS')
      const parts = readdirSync(partsDir)
        .filter((name) => name.endsWith('.bin'))
        .sort()
      const writer = createWriteStream(modelPath)
      for (const part of parts) {
        await pipeline(createReadStream(join(partsDir, part)), writer, { end: false })
      }
      writer.end()
      await new Promise((res, rej) => {
        writer.on('finish', res)
        writer.on('error', rej)
      })
      const digest = await sha256File(modelPath)
      if (digest !== EXPECTED_SHA256) {
        rmSync(modelPath, { force: true })
        throw new Error(`SHA-256 mismatch: expected ${EXPECTED_SHA256}, got ${digest}`)
      }
    } finally {
      rmSync(tempClone, { recursive: true, force: true })
    }
  }

  if (!existsSync(llamaEntry)) {
    console.log('[NEW1 Local Engine] Installing prebuilt CPU llama.cpp runtime (node-llama-cpp)…')
    if (!existsSync(join(runtimeDir, 'package.json'))) {
      execFileSync('npm', ['init', '-y'], { cwd: runtimeDir, stdio: 'ignore', shell: false })
    }
    execFileSync('npm', ['install', 'node-llama-cpp', '--no-audit', '--no-fund'], {
      cwd: runtimeDir,
      stdio: 'inherit',
      shell: false
    })
  }

  return { modelPath, llamaEntry }
}

function readJsonBody(req) {
  return new Promise((res, rej) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        res(raw ? JSON.parse(raw) : {})
      } catch (err) {
        rej(err)
      }
    })
    req.on('error', rej)
  })
}

function formatConversationPrompt(messages) {
  const lines = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      lines.push(`User:\n${m.content}`)
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          lines.push(
            `Assistant Tool Call: ${tc.function?.name}(${JSON.stringify(tc.function?.arguments ?? {})})`
          )
        }
      }
      if (m.content) lines.push(`Assistant:\n${m.content}`)
    } else if (m.role === 'tool') {
      lines.push(`Verified Tool Output (${m.tool_name ?? 'tool'}):\n${String(m.content).slice(0, 2500)}`)
    }
  }
  return lines.join('\n\n')
}

export async function startEmbeddedOllamaServer({
  host = '127.0.0.1',
  port = Number(process.env.OLLAMA_PORT ?? 11434)
} = {}) {
  const { modelPath, llamaEntry } = await ensureEmbeddedRuntime()
  const { getLlama, LlamaChatSession } = await import(pathToFileURL(llamaEntry).href)

  const llama = await getLlama({ gpu: false })
  const model = await llama.loadModel({ modelPath })
  const modelSize = statSync(modelPath).size
  const modifiedAt = statSync(modelPath).mtime.toISOString()

  let queue = Promise.resolve()
  const runExclusive = (fn) => {
    const next = queue.then(fn, fn)
    queue = next.catch(() => {})
    return next
  }

  function normalizeRelativeTarget(rawPath) {
    const trimmed = String(rawPath ?? '')
      .trim()
      .replace(/^\.\/+/, '')
      .replace(/^\/+/, '')
    if (!trimmed || trimmed.includes('..')) return ''
    return trimmed
  }

  async function generateFileContent(targetPath, messages, signal) {
    const context = await model.createContext({ contextSize: 2048, threads: 2, batchSize: 128 })
    try {
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt:
          'Generate ONLY the clean file content for the target file requested by the user. Do not wrap in explanations.'
      })
      const raw = await session.prompt(
        `Target file: ${targetPath}\n\n${formatConversationPrompt(messages)}`,
        { maxTokens: 420, temperature: 0.25, signal }
      )
      const cleaned = raw
        .replace(/^```[a-zA-Z0-9_-]*\r?\n/, '')
        .replace(/\r?\n```\s*$/, '')
        .trim()
      return cleaned ? `${cleaned}\n` : `# ${targetPath}\n`
    } finally {
      await context.dispose()
    }
  }

  async function decideToolCall(messages, tools, signal) {
    const toolNames = tools.map((t) => t.function?.name).filter(Boolean)
    const priorToolResults = messages.filter((m) => m.role === 'tool')
    const hasSuccessfulTool = priorToolResults.some(
      (m) => !String(m.content ?? '').startsWith('ERROR:')
    )
    if (toolNames.length === 0 || priorToolResults.length >= 2 || hasSuccessfulTool) {
      return null
    }

    const schema = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['call_tool', 'final_answer'] },
        tool_name: {
          type: 'string',
          enum: [...toolNames.filter((n) => n !== 'make_directory'), 'none']
        },
        path: { type: 'string' },
        query: { type: 'string' }
      },
      required: ['action', 'tool_name', 'path', 'query']
    }

    const firstUserMsg = messages.find((m) => m.role === 'user')?.content ?? ''
    const rawUserRequest = firstUserMsg.split('\n\nExecution plan:')[0].trim()

    const grammar = await llama.createGrammarForJsonSchema(schema)
    const context = await model.createContext({ contextSize: 2048, threads: 2, batchSize: 128 })
    let parsed
    try {
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: [
          'Choose ONE tool call as compact JSON matching the schema.',
          'Examples:',
          'User: أنشئ ملف notes.md يحتوي على خطة -> {"action":"call_tool","tool_name":"write_file","path":"notes.md","query":""}',
          'User: Create hello.html welcome page -> {"action":"call_tool","tool_name":"write_file","path":"hello.html","query":""}',
          'User: استعرض الملفات الموجودة في مساحة العمل -> {"action":"call_tool","tool_name":"list_files","path":".","query":""}',
          'User: اقرأ ملف welcome.md -> {"action":"call_tool","tool_name":"read_file","path":"welcome.md","query":""}'
        ].join('\n')
      })

      const raw = await session.prompt(`User: ${rawUserRequest}`, {
        grammar,
        maxTokens: 120,
        temperature: 0.05,
        signal
      })
      parsed = JSON.parse(raw)
    } catch {
      return null
    } finally {
      await context.dispose()
    }

    if (!parsed || parsed.action !== 'call_tool' || !toolNames.includes(parsed.tool_name)) {
      return null
    }

    const cleanPath = normalizeRelativeTarget(parsed.path)
    const args = {}
    if (parsed.tool_name === 'list_files') {
      args.path = cleanPath || '.'
      args.recursive = true
    } else if (parsed.tool_name === 'read_file' || parsed.tool_name === 'delete_file') {
      if (!cleanPath) return null
      args.path = cleanPath
    } else if (parsed.tool_name === 'write_file') {
      const filePath = cleanPath || 'output.md'
      args.path = filePath
      args.content = await generateFileContent(filePath, messages, signal)
    } else if (parsed.tool_name === 'search_files') {
      args.query = parsed.query && parsed.query.trim().length >= 2 ? parsed.query.trim() : 'NEW1'
      args.path = cleanPath || '.'
    } else {
      return null
    }

    return {
      function: {
        name: parsed.tool_name,
        arguments: args
      }
    }
  }

  async function streamTextReply(messages, stream, response, signal) {
    const systemMsg =
      messages.find((m) => m.role === 'system')?.content ??
      'You are NEW1, a concise helpful AI assistant. Reply clearly in the user language.'
    const context = await model.createContext({ contextSize: 2048, threads: 2, batchSize: 128 })
    try {
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: `${systemMsg}\nKeep your answer concise, accurate, and directly in the same language as the user's request.`
      })

      let full = ''
      await session.prompt(formatConversationPrompt(messages), {
        maxTokens: 280,
        temperature: 0.25,
        signal,
        onTextChunk(chunk) {
          full += chunk
          if (stream && !response.writableEnded) {
            response.write(
              `${JSON.stringify({
                model: MODEL_TAG,
                created_at: new Date().toISOString(),
                message: { role: 'assistant', content: chunk },
                done: false
              })}\n`
            )
          }
        }
      })

      if (stream) {
        if (!response.writableEnded) {
          response.write(
            `${JSON.stringify({
              model: MODEL_TAG,
              created_at: new Date().toISOString(),
              message: { role: 'assistant', content: '' },
              done: true
            })}\n`
          )
          response.end()
        }
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(
          JSON.stringify({
            model: MODEL_TAG,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: full },
            done: true
          })
        )
      }
    } finally {
      await context.dispose()
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`)
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/version')) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(
        JSON.stringify({
          version: '0.6.0-new1-llamacpp',
          engine: 'llama.cpp (CPU GGUF)',
          model: MODEL_TAG
        })
      )
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/tags') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(
        JSON.stringify({
          models: [
            {
              name: MODEL_TAG,
              model: MODEL_TAG,
              modified_at: modifiedAt,
              size: modelSize,
              digest: EXPECTED_SHA256,
              details: {
                format: 'gguf',
                family: 'qwen2.5',
                parameter_size: '0.5B',
                quantization_level: 'Q4_K_M'
              }
            }
          ]
        })
      )
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const abortController = new AbortController()
      request.on('aborted', () => abortController.abort())
      response.on('close', () => {
        if (!response.writableEnded) abortController.abort()
      })

      try {
        const body = await readJsonBody(request)
        const messages = Array.isArray(body.messages) ? body.messages : []
        const tools = Array.isArray(body.tools) ? body.tools : []
        const stream = Boolean(body.stream)

        if (stream) {
          response.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
        }

        await runExclusive(async () => {
          if (abortController.signal.aborted) return
          const toolCall = await decideToolCall(messages, tools, abortController.signal)
          if (toolCall) {
            const payload = {
              model: MODEL_TAG,
              created_at: new Date().toISOString(),
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [toolCall]
              },
              done: true
            }
            if (stream) {
              response.end(`${JSON.stringify(payload)}\n`)
            } else {
              response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify(payload))
            }
            return
          }

          await streamTextReply(messages, stream, response, abortController.signal)
        })
      } catch (error) {
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: error.message }))
        } else if (!response.writableEnded) {
          response.end(`${JSON.stringify({ error: error.message, done: true })}\n`)
        }
      }
      return
    }

    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: 'Not found' }))
  })

  await new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(port, host, res)
  })

  console.log(`[NEW1 Local Engine] Serving ${MODEL_TAG} via Ollama wire API at http://${host}:${port}`)
  return {
    server,
    close: async () => {
      await new Promise((res) => server.close(res))
      await model.dispose()
      await llama.dispose()
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--setup-only')) {
    const info = await ensureEmbeddedRuntime()
    console.log(`[NEW1 Local Engine] Ready at ${info.modelPath}`)
    process.exit(0)
  }
  const handle = await startEmbeddedOllamaServer()
  const stop = async () => {
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
