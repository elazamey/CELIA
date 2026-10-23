#!/usr/bin/env node
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.mjs'
import { OllamaProvider } from './provider.mjs'
import { TaskStore } from './store.mjs'
import { TaskManager } from './task-manager.mjs'
import { WorkspaceTools } from './tools.mjs'
import {
  checkTargetRepository,
  publishStandaloneRepository
} from '../scripts/publish-standalone.mjs'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

function commonHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors *; base-uri 'none'; form-action 'self'"
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    ...commonHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(JSON.stringify(payload))
}

function readJson(request, limit = 512_000) {
  return new Promise((resolvePromise, reject) => {
    let raw = ''
    let tooLarge = false
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      if (Buffer.byteLength(raw) + Buffer.byteLength(chunk) > limit) {
        tooLarge = true
        return
      }
      raw += chunk
    })
    request.on('end', () => {
      if (tooLarge) {
        const error = new Error('Request body is too large')
        error.status = 413
        reject(error)
        return
      }
      try {
        resolvePromise(raw ? JSON.parse(raw) : {})
      } catch {
        const error = new Error('Invalid JSON request body')
        error.status = 400
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function isSameOriginRequest(request) {
  const origin = request.headers.origin
  if (!origin) return true
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  const allowedHosts = new Set()
  if (request.headers.host) allowedHosts.add(request.headers.host.trim())
  const forwarded = request.headers['x-forwarded-host']
  if (typeof forwarded === 'string') {
    for (const part of forwarded.split(',')) {
      if (part.trim()) allowedHosts.add(part.trim())
    }
  }
  return allowedHosts.has(originHost)
}

function serveStatic(response, publicDir, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendJson(response, 400, { error: 'Invalid path' })
    return
  }
  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const filePath = resolve(publicDir, relativePath)
  const root = resolve(publicDir)
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    sendJson(response, 403, { error: 'Forbidden' })
    return
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(response, 404, { error: 'Not found' })
    return
  }
  response.writeHead(200, {
    ...commonHeaders(),
    'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache'
  })
  response.end(readFileSync(filePath))
}

export async function createApplication({ configOverrides = {}, provider: injectedProvider } = {}) {
  const config = loadConfig(configOverrides)
  const store = new TaskStore(config.dataDir).init()
  const provider =
    injectedProvider ??
    new OllamaProvider({
      baseUrl: config.ollamaUrl,
      model: config.model,
      timeoutMs: config.requestTimeoutMs
    })
  const manager = new TaskManager({ config, store, provider })
  const workspaceTools = new WorkspaceTools({ workspaceDir: config.workspaceDir })
  const eventClients = new Set()

  const broadcastEvent = (eventName, data) => {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of eventClients) {
      if (!client.response.writableEnded) client.response.write(payload)
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://new1.local')
    const { pathname } = url

    try {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
        if (!isSameOriginRequest(request)) {
          sendJson(response, 403, { error: 'Cross-origin task changes are not allowed' })
          return
        }
      }

      if (request.method === 'GET' && pathname === '/api/health') {
        const health = await provider.health()
        sendJson(response, 200, {
          ...health,
          service: 'new1',
          version: '0.2.0',
          ollamaVersion: health.version ?? null,
          tasks: manager.stats(),
          orca: {
            installed:
              existsSync(resolve(config.orcaDir, 'package.json')) ||
              existsSync(resolve(config.rootDir, '..', 'orca', 'package.json')),
            path: existsSync(resolve(config.orcaDir, 'package.json'))
              ? 'vendor/orca'
              : existsSync(resolve(config.rootDir, '..', 'orca', 'package.json'))
                ? '../orca (CELIA submodule)'
                : 'vendor/orca',
            source: 'https://github.com/stablyai/orca'
          },
          limits: { maxSteps: config.maxSteps, maxConcurrency: config.maxConcurrency }
        })
        return
      }

      if (request.method === 'GET' && pathname === '/api/models') {
        try {
          sendJson(response, 200, { models: await provider.listModels() })
        } catch (error) {
          sendJson(response, 503, { error: error.message, models: [] })
        }
        return
      }

      if (request.method === 'GET' && pathname === '/api/tasks') {
        sendJson(response, 200, { tasks: manager.list() })
        return
      }

      if (request.method === 'POST' && pathname === '/api/tasks') {
        const task = manager.create(await readJson(request))
        sendJson(response, 202, { task })
        return
      }

      if (request.method === 'GET' && pathname === '/api/tasks/export') {
        sendJson(response, 200, manager.exportBundle())
        return
      }

      if (request.method === 'POST' && pathname === '/api/tasks/import') {
        const imported = manager.importBundle(await readJson(request, 2_000_000))
        sendJson(response, 200, { ok: true, imported, tasks: manager.list() })
        return
      }

      if (request.method === 'DELETE' && pathname === '/api/tasks/finished') {
        const removed = manager.clearFinished()
        sendJson(response, 200, { ok: true, removed })
        return
      }

      const actionMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/(resume|approve)$/)
      if (actionMatch && request.method === 'POST') {
        const [, id, action] = actionMatch
        if (action === 'resume') {
          const task = manager.resume(id)
          sendJson(response, task ? 202 : 404, task ? { task } : { error: 'Task not found' })
          return
        }
        if (action === 'approve') {
          const body = await readJson(request)
          const task = manager.approve(id, body)
          sendJson(response, task ? 200 : 404, task ? { task } : { error: 'Task not found' })
          return
        }
      }

      const taskMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/)
      if (taskMatch && request.method === 'GET') {
        const task = manager.get(taskMatch[1])
        sendJson(response, task ? 200 : 404, task ? { task } : { error: 'Task not found' })
        return
      }
      if (taskMatch && request.method === 'DELETE') {
        if (url.searchParams.get('purge') === 'true') {
          const deleted = manager.deleteTask(taskMatch[1])
          sendJson(response, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'Task not found' })
          return
        }
        const task = manager.cancel(taskMatch[1])
        sendJson(response, task ? 202 : 404, task ? { task } : { error: 'Task not found' })
        return
      }

      if (request.method === 'GET' && pathname === '/api/events') {
        response.writeHead(200, {
          ...commonHeaders(),
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        response.write('retry: 2000\nevent: ready\ndata: {"ok":true}\n\n')
        const client = { response }
        eventClients.add(client)
        const heartbeat = setInterval(() => {
          if (!response.writableEnded) response.write(': heartbeat\n\n')
        }, 20_000)
        request.on('close', () => {
          clearInterval(heartbeat)
          eventClients.delete(client)
        })
        return
      }

      if (request.method === 'GET' && pathname === '/api/files') {
        try {
          const listing = await workspaceTools.execute('list_files', {
            path: url.searchParams.get('path') ?? '.',
            recursive: url.searchParams.get('recursive') !== 'false'
          })
          response.writeHead(200, {
            ...commonHeaders(),
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          })
          response.end(listing)
        } catch (error) {
          sendJson(response, 400, { error: error.message })
        }
        return
      }

      if (request.method === 'POST' && pathname === '/api/files') {
        try {
          const body = await readJson(request)
          const saved = JSON.parse(
            await workspaceTools.execute('write_file', {
              path: body.path,
              content: body.content ?? ''
            })
          )
          sendJson(response, 201, saved)
        } catch (error) {
          sendJson(response, 400, { error: error.message })
        }
        return
      }

      if (request.method === 'DELETE' && pathname === '/api/files') {
        try {
          const path = url.searchParams.get('path') ?? ''
          const deleted = JSON.parse(await workspaceTools.execute('delete_file', { path }))
          sendJson(response, 200, deleted)
        } catch (error) {
          sendJson(response, 400, { error: error.message })
        }
        return
      }

      if (request.method === 'GET' && pathname === '/api/files/content') {
        try {
          const path = url.searchParams.get('path') ?? ''
          const content = await workspaceTools.execute('read_file', { path })
          sendJson(response, 200, { path, content })
        } catch (error) {
          sendJson(response, 400, { error: error.message })
        }
        return
      }

      if (request.method === 'GET' && pathname === '/api/publish/status') {
        try {
          sendJson(response, 200, checkTargetRepository('elazamey/new1'))
        } catch (error) {
          sendJson(response, 400, { error: error.message })
        }
        return
      }

      if (request.method === 'POST' && pathname === '/api/publish') {
        try {
          const body = await readJson(request)
          const result = publishStandaloneRepository({
            repoSlug: 'elazamey/new1',
            dryRun: Boolean(body.dryRun)
          })
          sendJson(response, result.published || body.dryRun ? 200 : 409, result)
        } catch (error) {
          sendJson(response, 500, { error: error.message })
        }
        return
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && !pathname.startsWith('/api/')) {
        serveStatic(response, config.publicDir, pathname)
        return
      }

      sendJson(response, 404, { error: 'Not found' })
    } catch (error) {
      sendJson(response, error.status ?? 400, { error: error.message })
    }
  })

  manager.on('update', (task) => broadcastEvent('task', { task }))
  manager.on('stream', (chunk) => broadcastEvent('stream', chunk))
  manager.on('deleted', (info) => broadcastEvent('deleted', info))
  manager.on('cleared', (info) => broadcastEvent('cleared', info))
  manager.on('imported', (info) => broadcastEvent('imported', info))

  server.on('close', () => {
    manager.shutdown()
    for (const client of eventClients) client.response.end()
    eventClients.clear()
  })

  return { server, config, manager, provider }
}

async function maybeStartEmbeddedEngine(config, provider) {
  if (process.env.NEW1_DISABLE_EMBEDDED_ENGINE === '1') return null
  const currentHealth = await provider.health()
  if (currentHealth.ok) return null

  const candidatePaths = [
    resolve(config.rootDir, '.cache', 'models', 'qwen2.5-0.5b-instruct-q4_k_m.gguf'),
    resolve(config.rootDir, '..', '.cache', 'models', 'qwen2.5-0.5b-instruct-q4_k_m.gguf')
  ]
  const hasCachedModel = candidatePaths.some((p) => existsSync(p))
  if (!hasCachedModel && process.env.NEW1_AUTO_LOCAL_ENGINE !== '1') {
    return null
  }

  try {
    const { startEmbeddedOllamaServer } = await import('../scripts/local-ollama-engine.mjs')
    const parsedUrl = new URL(config.ollamaUrl)
    return await startEmbeddedOllamaServer({
      host: '127.0.0.1',
      port: Number(parsedUrl.port || 11434)
    })
  } catch (error) {
    console.warn(`[NEW1] Embedded CPU engine failed to start: ${error.message}`)
    return null
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, config, manager, provider } = await createApplication()
  const embedded = await maybeStartEmbeddedEngine(config, provider)
  server.listen(config.port, config.host, () => {
    console.log(`[NEW1] http://${config.host}:${config.port}`)
    console.log(`[NEW1] Local model: ${config.model} via ${config.ollamaUrl}`)
    console.log(`[NEW1] Workspace: ${config.workspaceDir}`)
  })
  const shutdown = async () => {
    manager.shutdown()
    if (embedded) await embedded.close().catch(() => {})
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
