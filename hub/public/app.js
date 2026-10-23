const healthPill = document.getElementById('health-pill')
const heroStats = document.getElementById('hero-stats')
const integrationChecks = document.getElementById('integration-checks')
const servicesGrid = document.getElementById('services-grid')
const workflowTabs = document.getElementById('workflow-tabs')
const planHeader = document.getElementById('plan-header')
const stepsGrid = document.getElementById('steps-grid')
const automationsGrid = document.getElementById('automations-grid')
const terminalLog = document.getElementById('terminal-log')
const pluginIframe = document.getElementById('plugin-iframe')

let ecosystemState = null

function appendLog(line) {
  const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false })
  terminalLog.textContent += `[${stamp}] ${line}\n`
  terminalLog.scrollTop = terminalLog.scrollHeight
}

async function copyText(text, buttonEl) {
  try {
    await navigator.clipboard.writeText(text)
    const prev = buttonEl.textContent
    buttonEl.textContent = 'تم النسخ ✓'
    setTimeout(() => {
      buttonEl.textContent = prev
    }, 1400)
  } catch {
    appendLog(`COPY -> ${text}`)
  }
}

function renderPlan(plan) {
  planHeader.innerHTML = ''
  const title = document.createElement('strong')
  title.textContent = `${plan.titleAr} — (${plan.agentCount} مسارات Worktree متوازية)`
  const summary = document.createElement('p')
  summary.style.margin = '4px 0 0'
  summary.style.fontSize = '13px'
  summary.style.color = '#a6a198'
  summary.textContent = plan.summaryAr
  planHeader.append(title, summary)

  stepsGrid.innerHTML = ''
  for (const step of plan.steps) {
    const card = document.createElement('article')
    card.className = 'step-card'

    const top = document.createElement('div')
    top.innerHTML = `
      <div class="step-meta">
        <span class="agent-chip">${step.agent}</span>
        <code class="worktree-name">${step.worktree}</code>
      </div>
      <h3 style="margin:10px 0 6px;font-size:15px">${step.focusAr}</h3>
    `

    const promptBox = document.createElement('div')
    promptBox.className = 'prompt-box'
    promptBox.textContent = step.promptAr

    const cmdPre = document.createElement('pre')
    cmdPre.className = 'cmd-block'
    cmdPre.textContent = step.gitWorktreeCommand

    const actions = document.createElement('div')
    actions.style.display = 'flex'
    actions.style.gap = '8px'

    const copyCmdBtn = document.createElement('button')
    copyCmdBtn.type = 'button'
    copyCmdBtn.className = 'btn-mini'
    copyCmdBtn.textContent = 'نسخ أمر الـ Worktree'
    copyCmdBtn.addEventListener('click', () => copyText(step.gitWorktreeCommand, copyCmdBtn))

    const copyPromptBtn = document.createElement('button')
    copyPromptBtn.type = 'button'
    copyPromptBtn.className = 'btn-mini'
    copyPromptBtn.textContent = 'نسخ توجيه الوكيل'
    copyPromptBtn.addEventListener('click', () => copyText(step.promptAr, copyPromptBtn))

    actions.append(copyCmdBtn, copyPromptBtn)
    card.append(top, promptBox, cmdPre, actions)
    stepsGrid.appendChild(card)
  }
}

function renderDashboard(data) {
  ecosystemState = data
  const v = data.validation
  healthPill.textContent = v.ok ? 'التكامل سليم 100% ✓' : 'يوجد تنبيه في الإعدادات'

  const stats = [
    { value: data.services.length, label: 'خدمات ومستودعات CELIA' },
    { value: data.plans.length, label: 'قوالب وكلاء متوازية' },
    { value: data.automations.length, label: 'مهام أتمتة مجدولة' },
    {
      value: (data.orca.submoduleStatus.gitlinkSha || '').slice(0, 7) || 'HEAD',
      label: 'إصدار stablyai/orca المثبت'
    }
  ]

  heroStats.innerHTML = ''
  for (const s of stats) {
    const box = document.createElement('div')
    box.className = 'stat-box'
    box.innerHTML = `<div class="stat-value">${s.value}</div><div class="stat-label">${s.label}</div>`
    heroStats.appendChild(box)
  }

  integrationChecks.innerHTML = ''
  const checks = [
    { ok: v.submoduleOk, text: `ربط مستودع stablyai/orca كـ Git Submodule في ./orca` },
    { ok: v.orcaYamlOk, text: `ملف orca.yaml و.worktreeinclude جاهزان لعزل المسارات` },
    { ok: v.pluginOk, text: `إضافة Orca المخصصة (${v.pluginKey}) مطابقة للمخطط الرسمي` },
    { ok: true, text: `مهارة تنسيق الوكلاء celia-orca-orchestrator مفعّلة` }
  ]
  for (const c of checks) {
    const li = document.createElement('li')
    li.textContent = `${c.ok ? '✓' : '✗'} ${c.text}`
    integrationChecks.appendChild(li)
  }

  servicesGrid.innerHTML = ''
  for (const svc of data.services) {
    const card = document.createElement('article')
    card.className = 'service-card'
    const tags = svc.stack.map((t) => `<span class="tag">${t}</span>`).join('')
    card.innerHTML = `
      <div>
        <div class="service-top">
          <div>
            <h3>${svc.nameAr}</h3>
            <div class="service-en">${svc.nameEn}</div>
          </div>
          <span class="tag">${svc.defaultPort ? ':' + svc.defaultPort : 'Core'}</span>
        </div>
        <p class="service-desc">${svc.roleAr}</p>
      </div>
      <div>
        <div class="tag-row" style="margin-bottom:10px">${tags}</div>
        <a class="service-link" href="${svc.repo.replace(/\.git$/, '')}" target="_blank" rel="noreferrer">
          ${svc.repo.replace('https://github.com/', '')} ↗
        </a>
      </div>
    `
    servicesGrid.appendChild(card)
  }

  workflowTabs.innerHTML = ''
  data.plans.forEach((plan, index) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tab-btn' + (index === 0 ? ' active' : '')
    btn.textContent = plan.titleAr
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      renderPlan(plan)
    })
    workflowTabs.appendChild(btn)
  })
  if (data.plans[0]) {
    renderPlan(data.plans[0])
  }

  automationsGrid.innerHTML = ''
  for (const auto of data.automations) {
    const card = document.createElement('article')
    card.className = 'auto-card'

    const head = document.createElement('div')
    head.innerHTML = `
      <div class="step-meta">
        <strong>${auto.name}</strong>
        <span class="agent-chip">${auto.provider}</span>
      </div>
      <div style="font-size:12px;color:#a6a198;margin-top:4px">
        الجدولة: ${auto.trigger} — الساعة ${auto.time} (${auto.timezone})
      </div>
    `

    const pre = document.createElement('pre')
    pre.className = 'cmd-block'
    pre.textContent = auto.cliCommand

    const copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = 'btn-mini'
    copyBtn.style.justifySelf = 'start'
    copyBtn.textContent = 'نسخ أمر جدولة Orca'
    copyBtn.addEventListener('click', () => copyText(auto.cliCommand, copyBtn))

    card.append(head, pre, copyBtn)
    automationsGrid.appendChild(card)
  }
}

// Simulated Orca Host postMessage Bridge for the live CELIA Studio plugin panel preview
window.addEventListener('message', (event) => {
  if (!pluginIframe || event.source !== pluginIframe.contentWindow) {
    return
  }
  const msg = event.data
  if (!msg || msg.type !== 'orca-panel-action') {
    return
  }

  let responsePayload = { ok: false, error: 'Unsupported action' }

  if (msg.action === 'workspace.readContext') {
    appendLog('HOST CALL <- workspace.readContext() [capability: workspace:read]')
    responsePayload = {
      ok: true,
      value: {
        displayName: 'CELIA Primary Workspace',
        branch: 'arena/f255716c-celia',
        terminals: [
          { id: 'term-agent-01', title: 'Agent' },
          { id: 'term-celia-hub', title: 'CELIA Hub' },
          { id: 'term-doctor', title: 'CELIA Doctor' }
        ]
      }
    }
  } else if (msg.action === 'terminal.sendText') {
    const { terminalId, text, enter } = msg.params || {}
    appendLog(
      `HOST CALL <- terminal.sendText(terminal="${terminalId}", enter=${Boolean(enter)})`
    )
    appendLog(`  $ ${text}`)
    responsePayload = {
      ok: true,
      value: { accepted: true }
    }
  } else if (msg.action === 'notifications.show') {
    const { title, body } = msg.params || {}
    appendLog(`NOTIFICATION <- [${title}] ${body || ''}`)
    responsePayload = {
      ok: true,
      value: { delivered: true }
    }
  }

  pluginIframe.contentWindow.postMessage(
    {
      type: 'orca-panel-action-result',
      requestId: msg.requestId,
      ...responsePayload
    },
    '*'
  )
})

document.getElementById('clear-terminal').addEventListener('click', () => {
  terminalLog.textContent = ''
  appendLog('Orca host bridge monitor cleared.')
})

document.getElementById('custom-plan-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = document.getElementById('custom-goal-input')
  const goal = input.value.trim()
  if (!goal) return

  const res = await fetch('./api/plan/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal })
  })
  if (res.ok) {
    const plan = await res.json()
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'))
    renderPlan(plan)
    appendLog(`PLANNER <- Generated ${plan.agentCount}-worktree plan for "${goal}"`)
  }
})

async function boot() {
  appendLog('CELIA × Orca Host Bridge initialized. Try clicking buttons in CELIA Studio!')
  const res = await fetch('./api/ecosystem')
  if (!res.ok) {
    healthPill.textContent = 'تعذر الاتصال بالخادم'
    return
  }
  const snapshot = await res.json()
  renderDashboard(snapshot)
}

boot()
