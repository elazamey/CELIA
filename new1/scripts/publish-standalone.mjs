#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECT_ROOT } from '../src/config.mjs'

const EXCLUDED_TOP_LEVEL = new Set([
  '.git',
  '.data',
  '.cache',
  'workspace',
  'vendor',
  'node_modules',
  '.env'
])

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export function checkTargetRepository(repoSlug = 'elazamey/new1') {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoSlug)) {
    throw new Error('اسم المستودع غير صالح. استخدم الصيغة owner/repo.')
  }
  const repoName = repoSlug.split('/')[1]
  const createUrl = `https://github.com/new?name=${encodeURIComponent(repoName)}&description=${encodeURIComponent('NEW1 — مساحة وكلاء ذكاء اصطناعي محلية ومجانية (Ollama + Orca)')}`
  const repoUrl = `https://github.com/${repoSlug}`

  try {
    const infoRaw = run('gh', ['api', `repos/${repoSlug}`], PROJECT_ROOT)
    const info = JSON.parse(infoRaw)
    return {
      exists: true,
      repoSlug,
      repoUrl: info.html_url ?? repoUrl,
      cloneUrl: info.clone_url ?? `${repoUrl}.git`,
      defaultBranch: info.default_branch ?? 'main',
      permissions: info.permissions ?? {},
      createUrl
    }
  } catch {
    return {
      exists: false,
      repoSlug,
      repoUrl,
      cloneUrl: `${repoUrl}.git`,
      createUrl
    }
  }
}

export function publishStandaloneRepository({
  repoSlug = 'elazamey/new1',
  branch = 'main',
  dryRun = false
} = {}) {
  const status = checkTargetRepository(repoSlug)
  const stagingDir = mkdtempSync(join(tmpdir(), 'new1-standalone-'))

  try {
    cpSync(PROJECT_ROOT, stagingDir, {
      recursive: true,
      filter: (source) => {
        if (source === PROJECT_ROOT) return true
        const rel = source.slice(PROJECT_ROOT.length + 1)
        const firstSegment = rel.split(/[\\/]/)[0]
        if (EXCLUDED_TOP_LEVEL.has(firstSegment) || firstSegment.startsWith('.env.')) {
          return false
        }
        return true
      }
    })

    // Verify 100% standalone self-sufficiency inside isolated temporary export directory
    const validationOutput = run('npm', ['run', 'validate'], stagingDir)

    run('git', ['init', '-b', branch], stagingDir)
    run('git', ['config', 'user.name', 'elazamey'], stagingDir)
    run('git', ['config', 'user.email', '206169629+elazamey@users.noreply.github.com'], stagingDir)
    run('git', ['add', '-A'], stagingDir)
    run(
      'git',
      ['commit', '-m', 'feat: publish standalone NEW1 v0.2 local-first AI agent workspace'],
      stagingDir
    )
    const commitSha = run('git', ['rev-parse', '--short', 'HEAD'], stagingDir)

    if (dryRun || !status.exists) {
      return {
        published: false,
        validationPassed: true,
        standaloneCommitPreview: commitSha,
        remoteExists: status.exists,
        repoSlug,
        repoUrl: status.repoUrl,
        createUrl: status.createUrl,
        validationSummary: validationOutput.split('\n').slice(-8).join('\n'),
        message: status.exists
          ? 'تم التحقق من الحزمة المستقلة بنجاح (وضع المعاينة دون دفع).'
          : `الحزمة المستقلة مفحوصة وجاهزة 100%، لكن المستودع ${repoSlug} غير موجود بعد على GitHub. أنشئ مستودعًا فارغًا باسم "${repoSlug.split('/')[1]}" ثم أعد الضغط للنشر الفوري.`
      }
    }

    run('git', ['remote', 'add', 'origin', status.cloneUrl], stagingDir)
    run('git', ['push', '-u', '--force-with-lease', 'origin', `${branch}:${branch}`], stagingDir)

    return {
      published: true,
      validationPassed: true,
      commit: commitSha,
      remoteExists: true,
      repoSlug,
      repoUrl: status.repoUrl,
      branch,
      message: `تم نشر مشروع NEW1 كمستودع مستقل بالكامل إلى ${status.repoUrl} (الفرع ${branch}، المراجعة ${commitSha}).`
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run')
  const slugArg = process.argv.find((arg) => arg.startsWith('--repo='))?.slice(7) ?? 'elazamey/new1'
  try {
    const result = publishStandaloneRepository({ repoSlug: slugArg, dryRun })
    console.log(JSON.stringify(result, null, 2))
    if (!result.published && !dryRun) process.exitCode = 2
  } catch (error) {
    console.error(`Publish error: ${error.message}`)
    process.exit(1)
  }
}
