const BASE_PROMPT = `You are NEW1, a local-first AI agent. Respond in the user's language.
Work only through the provided workspace tools. Be direct, factual, and useful.
Never claim that you changed a file or ran tests unless the corresponding tool succeeded.
Do not invent capabilities, sources, or results. Ask a concise clarification only when essential.
When the task is complete, provide a short summary of concrete changes and any verification.`

function summarizeArguments(name, args) {
  if (name === 'write_file') {
    return { path: args.path, bytes: Buffer.byteLength(String(args.content ?? '')) }
  }
  if (name === 'edit_file') {
    return {
      path: args.path,
      oldBytes: Buffer.byteLength(String(args.old_text ?? args.oldText ?? '')),
      newBytes: Buffer.byteLength(String(args.new_text ?? args.newText ?? ''))
    }
  }
  return Object.fromEntries(
    Object.entries(args ?? {}).map(([key, value]) => [key, String(value).slice(0, 300)])
  )
}

function canonicalSignature(name, args) {
  const sorted = Object.keys(args ?? {})
    .sort()
    .reduce((acc, k) => {
      acc[k] = args[k]
      return acc
    }, {})
  return `${name}:${JSON.stringify(sorted)}`
}

export function extractToolCalls(message) {
  const native = message?.tool_calls ?? []
  if (Array.isArray(native) && native.length > 0) {
    return {
      toolCalls: native,
      cleanContent: String(message.content ?? '').trim()
    }
  }

  const raw = String(message?.content ?? '')
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  const extracted = []
  let match
  while ((match = regex.exec(raw)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed?.name) {
        extracted.push({
          function: {
            name: parsed.name,
            arguments: parsed.arguments ?? parsed.parameters ?? {}
          }
        })
      }
    } catch {
      // Ignore malformed inline tag and rely on regular response flow
    }
  }

  if (extracted.length === 0) {
    return { toolCalls: [], cleanContent: raw.trim() }
  }

  return {
    toolCalls: extracted,
    cleanContent: raw.replace(regex, '').trim()
  }
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
  onActivity = () => {},
  onStream = null,
  onCheckpoint = () => {},
  requestApproval = null
}) {
  const resumeState = task.checkpoint && Array.isArray(task.checkpoint.messages)
    ? task.checkpoint
    : null

  let plan = resumeState?.plan ?? ''
  if (!resumeState && task.mode === 'team') {
    onActivity('status', 'المخطط يبني خطة تنفيذ مختصرة…', { role: 'planner' })
    onStream?.({ role: 'planner', reset: true, delta: '' })
    const planningMessage = await provider.chat({
      model: task.model,
      signal,
      onToken: onStream ? (delta) => onStream({ role: 'planner', reset: false, delta }) : undefined,
      messages: [
        {
          role: 'system',
          content:
            'You are a pragmatic planning agent. Return at most six concrete steps in the user language. Do not reveal hidden reasoning.'
        },
        { role: 'user', content: task.prompt }
      ]
    })
    plan = planningMessage.content?.trim() ?? ''
    if (plan) onActivity('plan', plan, { role: 'planner' })
  }

  const messages = resumeState
    ? structuredClone(resumeState.messages)
    : [
        { role: 'system', content: BASE_PROMPT },
        {
          role: 'user',
          content: plan ? `${task.prompt}\n\nExecution plan:\n${plan}` : task.prompt
        }
      ]

  if (resumeState) {
    onActivity('status', 'تمت استعادة السياق المحفوظ ومواصلة التنفيذ…', { role: 'builder' })
  }

  const seenSuccessfulCalls = new Set()
  let draft = ''

  for (let step = 0; step < maxSteps; step += 1) {
    throwIfCancelled(signal)
    onActivity('status', `المنفّذ يعمل — الخطوة ${step + 1} من ${maxSteps}`, {
      role: 'builder',
      step: step + 1
    })
    onStream?.({ role: 'builder', reset: true, delta: '' })

    const message = await provider.chat({
      model: task.model,
      messages,
      tools: tools.definitions(),
      signal,
      onToken: onStream ? (delta) => onStream({ role: 'builder', reset: false, delta }) : undefined
    })

    const { toolCalls, cleanContent } = extractToolCalls(message)
    messages.push(
      toolCalls.length > 0 && !message.tool_calls
        ? { role: 'assistant', content: cleanContent, tool_calls: toolCalls }
        : message
    )

    if (cleanContent) {
      draft = cleanContent
      onActivity('message', draft, { role: 'builder' })
    }

    if (toolCalls.length === 0) {
      if (!draft) throw new Error('النموذج لم يُرجع إجابة قابلة للاستخدام')
      onCheckpoint({ plan, messages, completedSteps: step + 1 })
      break
    }

    let duplicateDetected = false
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

      const sig = canonicalSignature(name, args)
      if (seenSuccessfulCalls.has(sig)) {
        duplicateDetected = true
        continue
      }

      if (task.approvalPolicy === 'approve-writes' && tools.isMutating(name) && requestApproval) {
        const preview = tools.describeMutation(name, args)
        onActivity('approval_requested', `بانتظار موافقتك لتشغيل ${name}`, {
          role: 'approval',
          name,
          arguments: summarizeArguments(name, args),
          preview
        })
        const decision = await requestApproval({
          tool: name,
          arguments: summarizeArguments(name, args),
          preview
        })
        throwIfCancelled(signal)
        if (!decision?.approved) {
          const reason = decision?.note?.trim() || 'رفض المستخدم تنفيذ هذه العملية.'
          messages.push({ role: 'tool', tool_name: name, content: `REJECTED_BY_USER: ${reason}` })
          onActivity('approval_rejected', `تم رفض ${name}: ${reason}`, { role: 'approval', name })
          continue
        }
        onActivity('approval_granted', `تمت الموافقة على ${name}`, { role: 'approval', name })
      }

      onActivity('tool', `تشغيل ${name}`, {
        role: 'tool',
        name,
        arguments: summarizeArguments(name, args)
      })

      let output
      let ok = true
      try {
        output = await tools.execute(name, args)
      } catch (error) {
        ok = false
        output = `ERROR: ${error.message}`
      }
      if (ok) seenSuccessfulCalls.add(sig)

      const content = String(output).slice(0, 30_000)
      messages.push({ role: 'tool', tool_name: name, content })
      onActivity('tool_result', `${name}: ${content.slice(0, 800)}`, { role: 'tool', name })
    }

    onCheckpoint({ plan, messages, completedSteps: step + 1 })

    if (duplicateDetected) {
      throwIfCancelled(signal)
      onStream?.({ role: 'builder', reset: true, delta: '' })
      const synthesis = await provider.chat({
        model: task.model,
        signal,
        tools: [],
        onToken: onStream ? (delta) => onStream({ role: 'builder', reset: false, delta }) : undefined,
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              'Tool execution is already complete. Do not call any more tools. Provide a concise, accurate summary in the user language based strictly on the verified tool results above.'
          }
        ]
      })
      const finalSummary = synthesis.content?.trim()
      if (finalSummary) {
        draft = finalSummary
        onActivity('message', draft, { role: 'builder' })
      }
      if (draft) break
    }

    if (step === maxSteps - 1) {
      throw new Error(`بلغت المهمة الحد الأقصى للخطوات (${maxSteps})`)
    }
  }

  if (task.mode === 'team') {
    throwIfCancelled(signal)
    onActivity('status', 'المراجع يتحقق من النتيجة والادعاءات…', { role: 'reviewer' })
    onStream?.({ role: 'reviewer', reset: true, delta: '' })
    const review = await provider.chat({
      model: task.model,
      signal,
      onToken: onStream ? (delta) => onStream({ role: 'reviewer', reset: false, delta }) : undefined,
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
