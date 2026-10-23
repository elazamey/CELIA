const state = {
  tasks: [],
  selectedTaskId: null,
  selectedFilePath: null,
  selectedFileContent: '',
  mode: 'agent',
  health: null,
  view: 'tasks',
  events: null,
  streams: new Map()
}

const $ = (id) => document.getElementById(id)
const elements = {
  prompt: $('prompt'),
  form: $('task-form'),
  run: $('run-button'),
  model: $('model-select'),
  approveWrites: $('approve-writes'),
  allowCommands: $('allow-commands'),
  taskList: $('task-list'),
  detailEmpty: $('detail-empty'),
  detailContent: $('detail-content'),
  activityList: $('activity-list'),
  health: $('health-pill'),
  banner: $('provider-banner'),
  toast: $('toast')
}

const STATUS_LABELS = {
  queued: 'في الانتظار',
  running: 'قيد التنفيذ',
  awaiting_approval: 'بانتظار موافقتك',
  completed: 'مكتملة',
  failed: 'فشلت',
  cancelled: 'ملغاة'
}

const ACTIVITY_LABELS = {
  status: 'الحالة',
  plan: 'المخطط',
  message: 'المنفّذ',
  tool: 'أداة',
  tool_result: 'نتيجة الأداة',
  review: 'المراجع',
  approval_requested: 'طلب موافقة',
  approval_granted: 'موافقة بشرية',
  approval_rejected: 'رفض بشري'
}

const STREAM_ROLE_LABELS = {
  planner: 'المخطط يكتب الخطة الآن…',
  builder: 'المنفّذ يولّد الإجابة مباشرة…',
  reviewer: 'المراجع يفحص المخرجات الآن…'
}

function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function svgIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#${id}`)
  svg.append(use)
  return svg
}

let toastTimer
function toast(message) {
  clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.hidden = false
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true
  }, 3800)
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`)
  return data
}

function formatTime(value) {
  const date = new Date(value)
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  return new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'short' }).format(date)
}

function statusBadge(status) {
  return node('span', `status-badge ${status}`, STATUS_LABELS[status] ?? status)
}

function mergeTask(task) {
  const index = state.tasks.findIndex((item) => item.id === task.id)
  if (index === -1) state.tasks.unshift(task)
  else state.tasks[index] = task
  state.tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    state.streams.delete(task.id)
  }
  if (!state.selectedTaskId) state.selectedTaskId = task.id
  renderTasks()
  if (state.selectedTaskId === task.id) renderDetail()
  refreshFileCountQuietly()
}

function renderStats() {
  const active = state.tasks.filter((task) =>
    ['queued', 'running', 'awaiting_approval'].includes(task.status)
  ).length
  const completed = state.tasks.filter((task) => task.status === 'completed').length
  $('stat-active').textContent = active
  $('stat-completed').textContent = completed
  $('task-count').textContent = state.tasks.length
  $('nav-task-count').textContent = state.tasks.length
}

function renderTasks() {
  renderStats()
  elements.taskList.replaceChildren()
  if (state.tasks.length === 0) {
    elements.taskList.append(
      node('div', 'empty-list', 'لا توجد مهام بعد. اضغط أحد الأمثلة السريعة بالأعلى أو اكتب مهمتك.')
    )
    renderDetail()
    return
  }

  for (const task of state.tasks) {
    const button = node('button', `task-item${task.id === state.selectedTaskId ? ' selected' : ''}`)
    button.type = 'button'
    button.addEventListener('click', () => {
      state.selectedTaskId = task.id
      renderTasks()
    })
    const top = node('div', 'task-item-top')
    top.append(node('h4', '', task.title), statusBadge(task.status))
    const footer = node('div', 'task-item-foot')
    const modeLabel =
      (task.mode === 'team' ? 'فريق · 3 أدوار' : 'وكيل واحد') +
      (task.approvalPolicy === 'approve-writes' ? ' · موافقة' : '')
    footer.append(node('span', '', modeLabel), node('time', '', formatTime(task.createdAt)))
    button.append(top, node('p', '', task.prompt), footer)
    elements.taskList.append(button)
  }
  renderDetail()
}

function renderStreamBox(task) {
  const streamWrap = $('stream-wrap')
  if (!task || !['running', 'queued'].includes(task.status)) {
    streamWrap.hidden = true
    return
  }
  const activeStream = state.streams.get(task.id)
  if (!activeStream || !activeStream.text) {
    streamWrap.hidden = true
    return
  }
  streamWrap.hidden = false
  $('stream-role').textContent = STREAM_ROLE_LABELS[activeStream.role] ?? 'النموذج يكتب الآن…'
  $('stream-content').textContent = activeStream.text
}

function renderApprovalBox(task) {
  const box = $('approval-box')
  const pending = task?.status === 'awaiting_approval' ? task.pendingApproval : null
  box.hidden = !pending
  if (!pending) return
  $('approval-title').textContent = `موافقة مطلوبة لتشغيل الأداة: ${pending.tool}`
  $('approval-preview').textContent = pending.preview || JSON.stringify(pending.arguments, null, 2)
}

function renderDetail() {
  const task = state.tasks.find((item) => item.id === state.selectedTaskId)
  elements.detailEmpty.hidden = Boolean(task)
  elements.detailContent.hidden = !task
  if (!task) return

  $('detail-title').textContent = task.title
  $('detail-prompt').textContent = task.prompt
  $('detail-status').replaceChildren(statusBadge(task.status))
  $('cancel-task').hidden = !['queued', 'running', 'awaiting_approval'].includes(task.status)
  $('resume-task').hidden = !['failed', 'cancelled'].includes(task.status)
  $('delete-task').hidden = ['queued', 'running', 'awaiting_approval'].includes(task.status)
  $('result-wrap').hidden = !task.result
  $('detail-result').textContent = task.result ?? ''
  $('detail-error').hidden = !task.error
  $('detail-error').textContent = task.error ?? ''

  renderApprovalBox(task)
  renderStreamBox(task)

  const activity = task.activity ?? []
  $('activity-count').textContent = `${activity.length} حدث`
  elements.activityList.replaceChildren()
  if (activity.length === 0) {
    elements.activityList.append(node('div', 'empty-list', 'في انتظار بدء التنفيذ…'))
    return
  }
  for (const item of activity.slice(-120)) {
    const row = node('article', `activity-item ${item.type}`)
    const meta = node('div', 'activity-meta')
    meta.append(
      node('span', 'activity-role', ACTIVITY_LABELS[item.type] ?? item.type),
      node(
        'time',
        '',
        new Intl.DateTimeFormat('ar-EG', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }).format(new Date(item.at))
      )
    )
    row.append(meta, node('div', 'activity-content', item.content))
    elements.activityList.append(row)
  }
  elements.activityList.scrollTop = elements.activityList.scrollHeight
}

async function loadTasks() {
  const data = await api('/api/tasks')
  state.tasks = data.tasks
  if (!state.selectedTaskId && state.tasks[0]) state.selectedTaskId = state.tasks[0].id
  renderTasks()
}

function updateModels(models, activeModel) {
  const selected = elements.model.value
  const names = [...new Set([...models.map((m) => m.name), activeModel].filter(Boolean))]
  elements.model.replaceChildren()
  for (const name of names) {
    const option = node('option', '', name)
    option.value = name
    elements.model.append(option)
  }
  elements.model.value = names.includes(selected) ? selected : names[0]
}

function renderHealth() {
  const health = state.health
  elements.health.classList.remove('checking', 'online', 'offline')
  if (!health) {
    elements.health.classList.add('offline')
    $('health-label').textContent = 'تعذر فحص الخادم'
    return
  }
  const activeName = health.activeModel || health.configuredModel
  elements.health.classList.add(health.ok ? 'online' : 'offline')
  $('health-label').textContent = health.ok
    ? `جاهز · ${activeName}`
    : 'النموذج المحلي غير متصل'
  elements.banner.hidden = health.ok && health.modelInstalled
  $('banner-title').textContent = health.ok
    ? `النموذج ${health.configuredModel} غير مثبت`
    : 'النموذج المحلي غير متصل'
  $('banner-text').textContent = health.ok
    ? `نفّذ ollama pull ${health.configuredModel} ثم أعد الفحص.`
    : 'شغّل ollama serve أو npm run model:serve، ثم اضغط مؤشر الاتصال لإعادة الفحص.'
  $('provider-detail').textContent = health.ok
    ? `متصل عبر ${health.url} · المحرك: ${health.engine ?? 'ollama'} · النماذج الجاهزة: ${health.models.map((m) => m.name).join(', ')}`
    : health.error
  $('provider-detail').className = `setting-status ${health.ok ? 'good' : 'bad'}`
  $('orca-detail').textContent = health.orca.installed
    ? `مصدر Orca مرتبط وجاهز في ${health.orca.path}.`
    : 'لم يُجلب المصدر بعد. نفّذ npm run orca:init عند الحاجة إلى تطبيق Orca.'
  $('orca-detail').className = `setting-status ${health.orca.installed ? 'good' : 'neutral'}`
  updateModels(health.models ?? [], activeName)
}

async function loadHealth() {
  elements.health.classList.add('checking')
  try {
    state.health = await api('/api/health')
  } catch {
    state.health = null
  }
  renderHealth()
}

async function checkPublishStatus() {
  try {
    const status = await api('/api/publish/status')
    const el = $('publish-status')
    if (status.exists) {
      el.textContent = `المستودع ${status.repoSlug} موجود على GitHub وجاهز للدفع المباشر الآن!`
      el.className = 'setting-status good'
    } else {
      el.textContent = `المستودع ${status.repoSlug} غير منشأ بعد على GitHub (HTTP 404). اضغط الزر (1) لإنشائه فارغًا ثم الزر (2) للنشر الفوري.`
      el.className = 'setting-status neutral'
    }
    if (status.createUrl) $('github-create-link').href = status.createUrl
  } catch {
    // Non-fatal
  }
}

function connectEvents() {
  if (state.events) state.events.close()
  const events = new EventSource('/api/events')
  state.events = events

  events.addEventListener('task', (event) => {
    const { task } = JSON.parse(event.data)
    mergeTask(task)
  })

  events.addEventListener('stream', (event) => {
    const { taskId, role, reset, delta } = JSON.parse(event.data)
    const prev = state.streams.get(taskId) ?? { role, text: '' }
    const nextText = reset ? delta : prev.text + delta
    state.streams.set(taskId, { role, text: nextText })
    if (state.selectedTaskId === taskId) {
      const task = state.tasks.find((item) => item.id === taskId)
      renderStreamBox(task)
    }
  })

  events.addEventListener('deleted', (event) => {
    const { id } = JSON.parse(event.data)
    state.tasks = state.tasks.filter((item) => item.id !== id)
    if (state.selectedTaskId === id) {
      state.selectedTaskId = state.tasks[0]?.id ?? null
    }
    renderTasks()
  })

  events.addEventListener('cleared', () => {
    loadTasks().catch(() => {})
  })

  events.addEventListener('imported', () => {
    loadTasks().catch(() => {})
  })

  events.onopen = () => {
    $('sse-state').classList.remove('reconnecting')
    $('sse-state').lastChild.textContent = ' متصل بالتحديثات الحية'
  }
  events.onerror = () => {
    $('sse-state').classList.add('reconnecting')
    $('sse-state').lastChild.textContent = ' جارٍ إعادة الاتصال…'
  }
}

function switchView(view) {
  state.view = view
  for (const name of ['tasks', 'workspace', 'settings']) {
    $(`view-${name}`).hidden = name !== view
  }
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view)
  })
  $('view-heading').textContent = {
    tasks: 'مركز المهام',
    workspace: 'ملفات مساحة العمل',
    settings: 'الإعداد والتكامل والنشر'
  }[view]
  if (view === 'workspace') loadFiles().catch((error) => toast(error.message))
  if (view === 'settings') {
    loadHealth()
    checkPublishStatus()
  }
}

async function refreshFileCountQuietly() {
  try {
    const data = await api('/api/files?recursive=true')
    const fileCount = data.entries.filter((e) => e.type === 'file').length
    $('nav-file-count').textContent = fileCount
    if (state.view === 'workspace') renderFileEntries(data.entries)
  } catch {
    // Ignore background count refresh errors
  }
}

function renderFileEntries(entries) {
  const list = $('file-list')
  list.replaceChildren()
  const filesOnly = entries.filter((e) => e.type === 'file')
  $('file-count').textContent = entries.length
  $('nav-file-count').textContent = filesOnly.length
  if (entries.length === 0) {
    list.append(node('div', 'empty-list', 'المجلد فارغ حاليًا. اطلب من الوكيل إنشاء أول ملف أو أنشئه يدويًا.'))
    return
  }
  for (const entry of entries) {
    const active = entry.path === state.selectedFilePath ? ' active' : ''
    const button = node(entry.type === 'file' ? 'button' : 'div', `file-entry ${entry.type}${active}`)
    if (entry.type === 'file') {
      button.type = 'button'
      button.addEventListener('click', () => previewFile(entry.path))
    }
    button.append(svgIcon(entry.type === 'file' ? 'i-file' : 'i-folder'), node('span', '', entry.path))
    list.append(button)
  }
}

async function loadFiles() {
  const data = await api('/api/files?recursive=true')
  renderFileEntries(data.entries)
}

async function previewFile(path) {
  try {
    const data = await api(`/api/files/content?path=${encodeURIComponent(path)}`)
    state.selectedFilePath = path
    state.selectedFileContent = data.content
    $('preview-name').textContent = path
    $('file-preview-content').textContent = data.content
    $('preview-actions').hidden = false
    loadFiles().catch(() => {})
  } catch (error) {
    toast(error.message)
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('تم النسخ إلى الحافظة')
  } catch {
    toast('تعذر النسخ تلقائيًا؛ حدّد النص وانسخه يدويًا')
  }
}

function setMode(mode) {
  state.mode = mode
  document.querySelectorAll('[data-mode]').forEach((item) => {
    const selected = item.dataset.mode === mode
    item.classList.toggle('selected', selected)
    item.setAttribute('aria-pressed', String(selected))
  })
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const prompt = elements.prompt.value.trim()
  if (!prompt) return
  elements.run.disabled = true
  try {
    const { task } = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        mode: state.mode,
        model: elements.model.value,
        approvalPolicy: elements.approveWrites.checked ? 'approve-writes' : 'auto',
        allowCommands: elements.allowCommands.checked
      })
    })
    state.selectedTaskId = task.id
    mergeTask(task)
    elements.prompt.value = ''
    $('prompt-count').textContent = '0 / 12000'
    toast('بدأت المهمة في مساحة العمل المحلية')
  } catch (error) {
    toast(error.message)
  } finally {
    elements.run.disabled = false
    elements.prompt.focus()
  }
})

elements.prompt.addEventListener('input', () => {
  $('prompt-count').textContent = `${elements.prompt.value.length} / 12000`
})

document.querySelectorAll('[data-starter]').forEach((chip) => {
  chip.addEventListener('click', () => {
    elements.prompt.value = chip.dataset.starter
    $('prompt-count').textContent = `${elements.prompt.value.length} / 12000`
    setMode(chip.dataset.starterMode || 'agent')
    elements.approveWrites.checked = chip.dataset.starterApprove === 'true'
    elements.prompt.focus()
  })
})

document.querySelectorAll('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode))
})

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.view))
})
document.querySelectorAll('[data-go-settings]').forEach((button) => {
  button.addEventListener('click', () => switchView('settings'))
})
document.querySelectorAll('[data-copy-target]').forEach((button) => {
  button.addEventListener('click', () => copyText($(button.dataset.copyTarget).textContent))
})

elements.health.addEventListener('click', loadHealth)
$('refresh-files').addEventListener('click', () => loadFiles().catch((error) => toast(error.message)))
$('copy-result').addEventListener('click', () => copyText($('detail-result').textContent))

$('cancel-task').addEventListener('click', async () => {
  if (!state.selectedTaskId) return
  try {
    await api(`/api/tasks/${state.selectedTaskId}`, { method: 'DELETE' })
    toast('تم إرسال إشارة إلغاء المهمة')
  } catch (error) {
    toast(error.message)
  }
})

$('resume-task').addEventListener('click', async () => {
  if (!state.selectedTaskId) return
  try {
    const { task } = await api(`/api/tasks/${state.selectedTaskId}/resume`, { method: 'POST', body: '{}' })
    mergeTask(task)
    toast('تم استئناف المهمة من آخر سياق محفوظ')
  } catch (error) {
    toast(error.message)
  }
})

$('delete-task').addEventListener('click', async () => {
  if (!state.selectedTaskId) return
  try {
    await api(`/api/tasks/${state.selectedTaskId}?purge=true`, { method: 'DELETE' })
    toast('حُذفت المهمة من السجل المحلي')
  } catch (error) {
    toast(error.message)
  }
})

$('approve-yes').addEventListener('click', async () => {
  if (!state.selectedTaskId) return
  try {
    await api(`/api/tasks/${state.selectedTaskId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approved: true })
    })
    toast('تمت الموافقة ومتابعة التنفيذ')
  } catch (error) {
    toast(error.message)
  }
})

$('approve-no').addEventListener('click', async () => {
  if (!state.selectedTaskId) return
  try {
    await api(`/api/tasks/${state.selectedTaskId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approved: false, note: 'رفض المستخدم التعديل من الواجهة' })
    })
    toast('تم رفض هذه العملية وإبلاغ الوكيل')
  } catch (error) {
    toast(error.message)
  }
})

$('export-tasks').addEventListener('click', async () => {
  try {
    const bundle = await api('/api/tasks/export')
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `new1-tasks-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    toast('تم تصدير سجل المهام')
  } catch (error) {
    toast(error.message)
  }
})

$('import-tasks-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const res = await api('/api/tasks/import', { method: 'POST', body: text })
    await loadTasks()
    toast(`تم استيراد ${res.imported} مهمة بنجاح`)
  } catch (error) {
    toast(error.message)
  }
})

$('clear-finished').addEventListener('click', async () => {
  try {
    const res = await api('/api/tasks/finished', { method: 'DELETE' })
    await loadTasks()
    toast(`حُذفت ${res.removed} مهمة منتهية`)
  } catch (error) {
    toast(error.message)
  }
})

$('new-file-btn').addEventListener('click', () => {
  $('new-file-form').hidden = !$('new-file-form').hidden
  if (!$('new-file-form').hidden) $('new-file-path').focus()
})

$('cancel-file-btn').addEventListener('click', () => {
  $('new-file-form').hidden = true
})

$('new-file-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const path = $('new-file-path').value.trim()
  const content = $('new-file-content').value
  if (!path) return
  try {
    await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content }) })
    $('new-file-form').hidden = true
    $('new-file-path').value = ''
    $('new-file-content').value = ''
    await previewFile(path)
    toast(`حُفظ الملف ${path} داخل مساحة العمل`)
  } catch (error) {
    toast(error.message)
  }
})

$('download-file-btn').addEventListener('click', () => {
  if (!state.selectedFilePath) return
  const blob = new Blob([state.selectedFileContent], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = state.selectedFilePath.split('/').pop()
  link.click()
  URL.revokeObjectURL(url)
})

$('delete-file-btn').addEventListener('click', async () => {
  if (!state.selectedFilePath) return
  const target = state.selectedFilePath
  try {
    await api(`/api/files?path=${encodeURIComponent(target)}`, { method: 'DELETE' })
    state.selectedFilePath = null
    state.selectedFileContent = ''
    $('preview-name').textContent = 'معاينة الملف'
    $('file-preview-content').textContent = 'اختر ملفًا نصيًا لعرض محتواه هنا.'
    $('preview-actions').hidden = true
    await loadFiles()
    toast(`حُذف الملف ${target}`)
  } catch (error) {
    toast(error.message)
  }
})

async function runPublish(dryRun) {
  const statusEl = $('publish-status')
  const btn = dryRun ? $('publish-dryrun-btn') : $('publish-now-btn')
  btn.disabled = true
  statusEl.textContent = dryRun
    ? 'جارٍ التحقق من الحزمة المستقلة وتشغيل جميع الاختبارات في بيئة معزولة…'
    : 'جارٍ فحص مستودع GitHub ودفع النسخة المستقلة إلى elazamey/new1…'
  statusEl.className = 'setting-status'
  try {
    const response = await fetch('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun })
    })
    const result = await response.json()
    statusEl.textContent = result.message || result.error
    statusEl.className = `setting-status ${result.published || (dryRun && result.validationPassed) ? 'good' : 'bad'}`
    toast(result.published ? 'تم النشر إلى GitHub بنجاح!' : result.message)
  } catch (error) {
    statusEl.textContent = error.message
    statusEl.className = 'setting-status bad'
    toast(error.message)
  } finally {
    btn.disabled = false
  }
}

$('publish-now-btn').addEventListener('click', () => runPublish(false))
$('publish-dryrun-btn').addEventListener('click', () => runPublish(true))

renderTasks()
await Promise.allSettled([loadTasks(), loadHealth(), refreshFileCountQuietly()])
connectEvents()
setInterval(loadHealth, 60_000)
