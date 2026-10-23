const state = {
  tasks: [],
  selectedTaskId: null,
  mode: 'agent',
  health: null,
  view: 'tasks',
  events: null
}

const $ = (id) => document.getElementById(id)
const elements = {
  prompt: $('prompt'),
  form: $('task-form'),
  run: $('run-button'),
  model: $('model-select'),
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
  review: 'المراجع'
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
  toastTimer = setTimeout(() => { elements.toast.hidden = true }, 3500)
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
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
  if (!state.selectedTaskId) state.selectedTaskId = task.id
  renderTasks()
  if (state.selectedTaskId === task.id) renderDetail()
}

function renderStats() {
  const active = state.tasks.filter((task) => ['queued', 'running'].includes(task.status)).length
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
    elements.taskList.append(node('div', 'empty-list', 'لا توجد مهام بعد. اكتب أول مهمة في الأعلى وابدأ.'))
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
    footer.append(
      node('span', '', task.mode === 'team' ? 'فريق · 3 أدوار' : 'وكيل واحد'),
      node('time', '', formatTime(task.createdAt))
    )
    button.append(top, node('p', '', task.prompt), footer)
    elements.taskList.append(button)
  }
  renderDetail()
}

function renderDetail() {
  const task = state.tasks.find((item) => item.id === state.selectedTaskId)
  elements.detailEmpty.hidden = Boolean(task)
  elements.detailContent.hidden = !task
  if (!task) return

  $('detail-title').textContent = task.title
  $('detail-prompt').textContent = task.prompt
  $('detail-status').replaceChildren(statusBadge(task.status))
  $('cancel-task').hidden = !['queued', 'running'].includes(task.status)
  $('result-wrap').hidden = !task.result
  $('detail-result').textContent = task.result ?? ''
  $('detail-error').hidden = !task.error
  $('detail-error').textContent = task.error ?? ''

  const activity = task.activity ?? []
  $('activity-count').textContent = `${activity.length} حدث`
  elements.activityList.replaceChildren()
  if (activity.length === 0) {
    elements.activityList.append(node('div', 'empty-list', 'في انتظار بدء التنفيذ…'))
    return
  }
  for (const item of activity.slice(-100)) {
    const row = node('article', `activity-item ${item.type}`)
    const meta = node('div', 'activity-meta')
    meta.append(
      node('span', 'activity-role', ACTIVITY_LABELS[item.type] ?? item.type),
      node('time', '', new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(item.at)))
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

function updateModels(models, configuredModel) {
  const selected = elements.model.value || configuredModel
  const names = [...new Set([configuredModel, ...models.map((model) => model.name)].filter(Boolean))]
  elements.model.replaceChildren()
  for (const name of names) {
    const option = node('option', '', name)
    option.value = name
    elements.model.append(option)
  }
  elements.model.value = names.includes(selected) ? selected : configuredModel
}

function renderHealth() {
  const health = state.health
  elements.health.classList.remove('checking', 'online', 'offline')
  if (!health) {
    elements.health.classList.add('offline')
    $('health-label').textContent = 'تعذر فحص الخادم'
    return
  }
  elements.health.classList.add(health.ok ? 'online' : 'offline')
  $('health-label').textContent = health.ok
    ? health.modelInstalled ? 'النموذج المحلي جاهز' : 'Ollama متصل · النموذج غير مثبت'
    : 'Ollama غير متصل'
  elements.banner.hidden = health.ok && health.modelInstalled
  $('banner-title').textContent = health.ok ? `النموذج ${health.configuredModel} غير مثبت` : 'Ollama غير متصل'
  $('banner-text').textContent = health.ok
    ? `نفّذ ollama pull ${health.configuredModel} ثم أعد الفحص.`
    : 'شغّل ollama serve على جهازك، ثم اضغط مؤشر الاتصال لإعادة الفحص.'
  $('setup-command').textContent = `ollama pull ${health.configuredModel}\nollama serve`
  $('provider-detail').textContent = health.ok
    ? `متصل عبر ${health.url} · ${health.models.length} نموذج مثبت`
    : health.error
  $('provider-detail').className = `setting-status ${health.ok ? 'good' : 'bad'}`
  $('orca-detail').textContent = health.orca.installed
    ? 'مصدر Orca موجود في vendor/orca وجاهز للتطوير.'
    : 'لم يُجلب المصدر بعد. نفّذ npm run orca:init عند الحاجة إلى تطبيق Orca.'
  $('orca-detail').className = `setting-status ${health.orca.installed ? 'good' : 'neutral'}`
  updateModels(health.models ?? [], health.configuredModel)
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

function connectEvents() {
  if (state.events) state.events.close()
  const events = new EventSource('/api/events')
  state.events = events
  events.addEventListener('task', (event) => {
    const { task } = JSON.parse(event.data)
    mergeTask(task)
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
    settings: 'الإعداد والتكامل'
  }[view]
  if (view === 'workspace') loadFiles().catch((error) => toast(error.message))
  if (view === 'settings') loadHealth()
}

async function loadFiles() {
  const data = await api('/api/files?recursive=true')
  const list = $('file-list')
  list.replaceChildren()
  $('file-count').textContent = data.entries.length
  if (data.entries.length === 0) {
    list.append(node('div', 'empty-list', 'المجلد فارغ. اطلب من الوكيل إنشاء أول ملف.'))
    return
  }
  for (const entry of data.entries) {
    const button = node(entry.type === 'file' ? 'button' : 'div', `file-entry ${entry.type}`)
    if (entry.type === 'file') {
      button.type = 'button'
      button.addEventListener('click', () => previewFile(entry.path))
    }
    button.append(svgIcon(entry.type === 'file' ? 'i-file' : 'i-folder'), node('span', '', entry.path))
    list.append(button)
  }
}

async function previewFile(path) {
  try {
    const data = await api(`/api/files/content?path=${encodeURIComponent(path)}`)
    $('preview-name').textContent = path
    $('file-preview-content').textContent = data.content
  } catch (error) {
    toast(error.message)
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('تم النسخ')
  } catch {
    toast('تعذر النسخ تلقائيًا؛ حدّد النص وانسخه يدويًا')
  }
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
        allowCommands: elements.allowCommands.checked
      })
    })
    state.selectedTaskId = task.id
    mergeTask(task)
    elements.prompt.value = ''
    $('prompt-count').textContent = '0 / 12000'
    toast('أُضيفت المهمة إلى مساحة العمل')
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

document.querySelectorAll('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    state.mode = button.dataset.mode
    document.querySelectorAll('[data-mode]').forEach((item) => {
      const selected = item === button
      item.classList.toggle('selected', selected)
      item.setAttribute('aria-pressed', String(selected))
    })
  })
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
    toast('طُلب إلغاء المهمة')
  } catch (error) {
    toast(error.message)
  }
})

renderTasks()
await Promise.allSettled([loadTasks(), loadHealth()])
connectEvents()
setInterval(loadHealth, 60_000)
