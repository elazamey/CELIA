#!/usr/bin/env node
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REPO_ROOT,
  buildWorkflowPlan,
  getSystemSnapshot,
  validateAll
} from '../scripts/celia-orchestrator.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, 'public')
const PLUGIN_PANEL_PATH = join(REPO_ROOT, 'plugins', 'celia-ops', 'panel.html')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(body)
}

function buildCustomTaskPlan(goalText = '') {
  const cleanGoal = String(goalText || '').trim() || 'تطوير ميزة جديدة في متجر CELIA للأزياء'
  const slug =
    cleanGoal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'feature'

  const tracks = [
    {
      worktree: `wt/${slug}-storefront`,
      agent: 'claude',
      focusAr: 'تطوير واجهة المتجر وتجربة العرض بالعربية RTL والهاتف المحمول',
      promptAr: `ضمن سياق منظومة CELIA، نفّذ جانب الواجهة وتجربة المستخدم للمهمة التالية: «${cleanGoal}» مع الالتزام الكامل بدعم العربية RTL وفحص التصميم عبر Orca Design Mode.`
    },
    {
      worktree: `wt/${slug}-ai-api`,
      agent: 'codex',
      focusAr: 'بناء منطق الـ API وتكامل المساعد الذكي (Groq / Gemini Fallback) والبيانات',
      promptAr: `ضمن سياق منظومة CELIA، نفّذ طبقة الخادم والبيانات وتكامل المساعد الذكي للمهمة التالية: «${cleanGoal}» مع التحقق من معالجة الأخطاء وعدم كشف أي أسرار.`
    },
    {
      worktree: `wt/${slug}-verify`,
      agent: 'codex',
      focusAr: 'كتابة الاختبارات الآلية والتحقق من بوابة الجودة والأمان قبل الدمج',
      promptAr: `اكتب وشغّل اختبارات شاملة تتحقق من نجاح المهمة: «${cleanGoal}»، ونفّذ npm run validate && npm test قبل فتح طلب الدمج نحو main.`
    }
  ]

  return {
    workflowId: `custom-${slug}`,
    titleAr: `خطة مخصصة: ${cleanGoal}`,
    titleEn: `Custom CELIA Plan (${slug})`,
    summaryAr:
      'تم توليد خطة متوازية معزولة عبر Git Worktrees لمنع تعارض الملفات وتسريع التنفيذ عبر وكلاء Orca.',
    agentCount: tracks.length,
    steps: tracks.map((item, idx) => {
      const suffix = item.worktree.replace(/^wt\//, '')
      const branch = `celia/custom/${suffix}`
      const worktreePath = `../CELIA-${suffix}`
      return {
        order: idx + 1,
        worktree: item.worktree,
        branch,
        worktreePath,
        agent: item.agent,
        focusAr: item.focusAr,
        promptAr: item.promptAr,
        gitWorktreeCommand: `git worktree add -b ${branch} ${worktreePath} HEAD`
      }
    })
  }
}

export function createHubServer(rootDir = REPO_ROOT) {
  return createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      })
      res.end()
      return
    }

    const url = new URL(req.url || '/', 'http://celia.local')
    const pathname = url.pathname

    if (req.method === 'GET' && pathname === '/api/health') {
      const validation = validateAll(rootDir)
      sendJson(res, 200, {
        status: validation.ok ? 'ok' : 'degraded',
        service: 'celia-orca-hub',
        orcaSubmoduleSha: validation.submodule.gitlinkSha,
        pluginKey: validation.plugin.pluginKey,
        validationOk: validation.ok
      })
      return
    }

    if (req.method === 'GET' && pathname === '/api/ecosystem') {
      sendJson(res, 200, getSystemSnapshot(rootDir))
      return
    }

    if (req.method === 'GET' && pathname.startsWith('/api/plan/')) {
      const id = decodeURIComponent(pathname.slice('/api/plan/'.length))
      sendJson(res, 200, buildWorkflowPlan(id, rootDir))
      return
    }

    if (req.method === 'POST' && pathname === '/api/plan/custom') {
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        if (raw.length < 16_384) raw += chunk
      })
      req.on('end', () => {
        try {
          const body = raw ? JSON.parse(raw) : {}
          sendJson(res, 200, buildCustomTaskPlan(body.goal))
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON request body' })
        }
      })
      return
    }

    if (req.method === 'GET' && pathname === '/plugin-preview/panel.html') {
      if (!existsSync(PLUGIN_PANEL_PATH)) {
        sendJson(res, 404, { error: 'Plugin panel not found' })
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      res.end(readFileSync(PLUGIN_PANEL_PATH))
      return
    }

    const relTarget = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const resolvedFile = resolve(PUBLIC_DIR, normalize(relTarget))
    if (!resolvedFile.startsWith(PUBLIC_DIR) || !existsSync(resolvedFile)) {
      sendJson(res, 404, { error: 'Not found', path: pathname })
      return
    }

    const ext = extname(resolvedFile).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    })
    res.end(readFileSync(resolvedFile))
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT || '4173', 10)
  const host = process.env.HOST || '0.0.0.0'
  const server = createHubServer()
  server.listen(port, host, () => {
    console.log(`[CELIA × Orca Hub] Listening on http://${host}:${port}`)
  })
}
