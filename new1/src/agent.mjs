const BASE_PROMPT = `You are NEW1, a local-first AI agent. Respond in the user's language.
Work only through the provided workspace tools. Be direct, factual, and useful.
Never claim that you changed a file or ran tests unless the corresponding tool succeeded.
Do not invent capabilities, sources, or results. Ask a concise clarification only when essential.
When the task is complete, provide a short summary of concrete changes and any verification.`

function summarizeArguments(name, args) {
  if (name === 'write_file') {
    return { path: args.path, bytes: Buffer.byteLength(String(args.content ?? '')) }
  }
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, String(value).slice(0, 300)])
  )
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw new DOMException('The task was cancelled', 'AbortError')
  }
}

export async function runAgentTask({
  task,
  provider,
  tools,
  signal,
  maxSteps = 10,
  onActivity = () => {}
}) {
  let plan = ''
  if (task.mode === 'team') {
    onActivity('status', 'المخطط يبني خطة تنفيذ مختصرة…', { role: 'planner' })
    const planningMessage = await provider.chat({
      model: task.model,
      signal,
      messages: [
        {
          role: 'system',
          content: 'You are a pragmatic planning agent. Return at most six concrete steps. Do not reveal hidden reasoning.'
        },
        { role: 'user', content: task.prompt }
      ]
    })
    plan = planningMessage.content?.trim() ?? ''
    if (plan) onActivity('plan', plan, { role: 'planner' })
  }

  const messages = [
    { role: 'system', content: BASE_PROMPT },
    {
      role: 'user',
      content: plan ? `${task.prompt}\n\nExecution plan:\n${plan}` : task.prompt
    }
  ]

  let draft = ''
  for (let step = 0; step < maxSteps; step += 1) {
    throwIfCancelled(signal)
    onActivity('status', `المنفّذ يعمل — الخطوة ${step + 1} من ${maxSteps}`, {
      role: 'builder',
      step: step + 1
    })

    const message = await provider.chat({
      model: task.model,
      messages,
      tools: tools.definitions(),
      signal
    })
    messages.push(message)
    const toolCalls = message.tool_calls ?? []

    if (message.content?.trim()) {
      draft = message.content.trim()
      onActivity('message', draft, { role: 'builder' })
    }

    if (toolCalls.length === 0) {
      if (!draft) throw new Error('النموذج لم يُرجع إجابة قابلة للاستخدام')
      break
    }

    for (const call of toolCalls) {
      throwIfCancelled(signal)
      const name = call.function?.name
      let args = call.function?.arguments ?? {}
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          args = {}
        }
      }
      if (!name) continue
      onActivity('tool', `تشغيل ${name}`, {
        role: 'tool',
        name,
        arguments: summarizeArguments(name, args)
      })

      let output
      try {
        output = await tools.execute(name, args)
      } catch (error) {
        output = `ERROR: ${error.message}`
      }
      const content = String(output).slice(0, 30_000)
      messages.push({ role: 'tool', tool_name: name, content })
      onActivity('tool_result', `${name}: ${content.slice(0, 800)}`, { role: 'tool', name })
    }

    if (step === maxSteps - 1) {
      throw new Error(`بلغت المهمة الحد الأقصى للخطوات (${maxSteps})`)
    }
  }

  if (task.mode === 'team') {
    throwIfCancelled(signal)
    onActivity('status', 'المراجع يتحقق من النتيجة والادعاءات…', { role: 'reviewer' })
    const review = await provider.chat({
      model: task.model,
      signal,
      messages: [
        {
          role: 'system',
          content: `${BASE_PROMPT}\nYou are now the reviewer. Check the result against the request. Do not claim unverified tests. Return a concise final answer with remaining risks.`
        },
        {
          role: 'user',
          content: `Original request:\n${task.prompt}\n\nPlan:\n${plan || 'No separate plan'}\n\nBuilder result:\n${draft}`
        }
      ]
    })
    const reviewed = review.content?.trim()
    if (reviewed) {
      onActivity('review', reviewed, { role: 'reviewer' })
      return reviewed
    }
  }

  return draft
}
