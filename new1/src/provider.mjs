export class OllamaProvider {
  constructor({ baseUrl, model, timeoutMs = 120_000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.model = model
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
  }

  async rawFetch(path, options = {}, signal) {
    const signals = [AbortSignal.timeout(this.timeoutMs)]
    if (signal) signals.push(signal)

    let response
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers },
        signal: AbortSignal.any(signals)
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new Error(
        `تعذر الوصول إلى Ollama على ${this.baseUrl}. شغّل "ollama serve" أو "npm run model:serve" وتأكد من العنوان.`,
        { cause: error }
      )
    }

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Ollama returned ${response.status}: ${detail.slice(0, 500)}`)
    }
    return response
  }

  async request(path, options = {}, signal) {
    const response = await this.rawFetch(path, options, signal)
    return response.json()
  }

  async listModels(signal) {
    const data = await this.request('/api/tags', {}, signal)
    return (data.models ?? []).map((model) => ({
      name: model.name,
      size: model.size ?? 0,
      modifiedAt: model.modified_at ?? null,
      family: model.details?.family ?? null,
      parameterSize: model.details?.parameter_size ?? null,
      quantization: model.details?.quantization_level ?? null
    }))
  }

  async health() {
    const signal = AbortSignal.timeout(5_000)
    try {
      const [models, version] = await Promise.all([
        this.listModels(signal),
        this.request('/api/version', {}, signal).catch(() => ({ version: 'unknown' }))
      ])
      const installed = models.some(
        (model) =>
          model.name === this.model ||
          model.name.split(':')[0] === this.model.split(':')[0]
      )
      return {
        ok: true,
        status: 'ready',
        provider: 'ollama',
        url: this.baseUrl,
        configuredModel: this.model,
        modelInstalled: installed || models.length > 0,
        activeModel: models.find((m) => m.name === this.model)?.name ?? models[0]?.name ?? this.model,
        version: version.version,
        engine: version.engine ?? 'ollama',
        models
      }
    } catch (error) {
      return {
        ok: false,
        status: 'offline',
        provider: 'ollama',
        url: this.baseUrl,
        configuredModel: this.model,
        modelInstalled: false,
        models: [],
        error: error.message
      }
    }
  }

  async chat({ messages, tools = [], model = this.model, signal, onToken }) {
    const streaming = typeof onToken === 'function'
    const body = {
      model,
      messages,
      stream: streaming,
      options: { temperature: 0.2 }
    }
    if (tools.length > 0) body.tools = tools

    const response = await this.rawFetch(
      '/api/chat',
      { method: 'POST', body: JSON.stringify(body) },
      signal
    )

    if (!streaming || !response.body) {
      const data = await response.json()
      if (!data.message) throw new Error('Ollama returned an empty response')
      return data.message
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''
    const toolCalls = []

    const consumeLine = (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      const payload = JSON.parse(trimmed)
      if (payload.error) throw new Error(String(payload.error))
      const msg = payload.message ?? {}
      if (msg.content) {
        fullContent += msg.content
        onToken(msg.content)
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        toolCalls.push(...msg.tool_calls)
      }
    }

    try {
      while (true) {
        if (signal?.aborted) {
          throw new DOMException('The task was cancelled', 'AbortError')
        }
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          consumeLine(line)
          newlineIndex = buffer.indexOf('\n')
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) consumeLine(line)
      }
    } finally {
      reader.releaseLock()
    }

    const assembled = { role: 'assistant', content: fullContent }
    if (toolCalls.length > 0) assembled.tool_calls = toolCalls
    return assembled
  }
}
