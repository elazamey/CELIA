// CELIA Fashion & AI Operations — Orca Out-of-Process Plugin Worker
// Runs in Orca's capability-gated Node worker without Electron privileges.

async function readCounter(orca, key) {
  const stored = await orca.host.call('storage.get', { key })
  return typeof stored?.value === 'number' ? stored.value : 0
}

async function incrementCounter(orca, key) {
  const next = (await readCounter(orca, key)) + 1
  await orca.host.call('storage.set', { key, value: next })
  return next
}

export default function activate(orca) {
  orca.commands.register('celia.workspace-summary', async () => {
    const [worktreesCreated, worktreesRemoved, agentCompletions] = await Promise.all([
      readCounter(orca, 'celia.worktreesCreated'),
      readCounter(orca, 'celia.worktreesRemoved'),
      readCounter(orca, 'celia.agentCompletions')
    ])
    const context = await orca.host.call('workspace.readContext', {})
    const summary = {
      activeBranch: context?.branch ?? null,
      activeWorktree: context?.displayName ?? null,
      openTerminals: Array.isArray(context?.terminals) ? context.terminals.length : 0,
      metrics: {
        worktreesCreated,
        worktreesRemoved,
        agentCompletions
      }
    }
    await orca.host.call('notifications.show', {
      title: 'CELIA Studio — ملخص النشاط',
      body: `الفرع: ${summary.activeBranch ?? 'غير محدد'} | اكتمل: ${agentCompletions} مهمة وكيل`
    })
    return summary
  })

  orca.commands.register('celia.reset-metrics', async () => {
    await Promise.all([
      orca.host.call('storage.set', { key: 'celia.worktreesCreated', value: 0 }),
      orca.host.call('storage.set', { key: 'celia.worktreesRemoved', value: 0 }),
      orca.host.call('storage.set', { key: 'celia.agentCompletions', value: 0 })
    ])
    await orca.host.call('notifications.show', {
      title: 'CELIA Studio',
      body: 'تمت إعادة ضبط عدادات الجلسة بنجاح.'
    })
    return { reset: true }
  })

  orca.events.on('worktree.created', async (payload) => {
    const count = await incrementCounter(orca, 'celia.worktreesCreated')
    orca.log(`[CELIA] worktree created (#${count}): ${payload.branch || payload.worktreeId}`)
    await orca.host.call('notifications.show', {
      title: 'CELIA — مسار عمل جديد جاهز',
      body: `${payload.branch || payload.worktreeId} (${payload.path})`
    })
  })

  orca.events.on('worktree.removed', async (payload) => {
    const count = await incrementCounter(orca, 'celia.worktreesRemoved')
    orca.log(`[CELIA] worktree archived (#${count}): ${payload.worktreeId}`)
  })

  orca.events.on('agent.status.changed', async (payload) => {
    const finished =
      payload?.mainAgent?.state === 'done' &&
      payload?.mainAgent?.outcome !== 'interruption' &&
      payload?.state !== 'working'
    if (!finished) {
      return
    }
    const count = await incrementCounter(orca, 'celia.agentCompletions')
    orca.log(`[CELIA] agent turn completed (#${count}) in ${payload.worktreeId ?? 'workspace'}`)
    await orca.host.call('notifications.show', {
      title: 'CELIA — أنهى الوكيل مهمته',
      body: `اكتملت المهمة رقم #${count}؛ تذكر تشغيل npm test قبل الدمج.`
    })
  })
}
