export class OllamaProvider {
  constructor({ baseUrl, model, timeoutMs = 120_000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.model = model
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
  }

  async request(path, options = {}, signal) {
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
        `تعذر الوصول إلى Ollama على ${this.baseUrl}. شغّل "ollama serve" وتأكد من العنوان.`,
        { cause: error }
      )
    }

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Ollama returned ${response.status}: ${detail.slice(0, 500)}`)
    }
    return response.json()
  }

  async listModels(signal) {
    const data = await this.request('/api/tags', {}, signal)
    return (data.models ?? []).map((model) => ({
      name: model.name,
      size: model.size ?? 0,
      modifiedAt: model.modified_at ?? null
    }))
  }

  async health() {
    const signal = AbortSignal.timeout(5_000)
    try {
      const [models, version] = await Promise.all([
        this.listModels(signal),
        this.request('/api/version', {}, signal).catch(() => ({ version: 'unknown' }))
      ])
      return {
        ok: true,
        status: 'ready',
        provider: 'ollama',
        url: this.baseUrl,
        configuredModel: this.model,
        modelInstalled: models.some((model) => model.name === this.model),
        version: version.version,
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

  async chat({ messages, tools = [], model = this.model, signal }) {
    const body = {
      model,
      messages,
      stream: false,
      options: { temperature: 0.2 }
    }
    if (tools.length > 0) body.tools = tools

    const data = await this.request(
      '/api/chat',
      { method: 'POST', body: JSON.stringify(body) },
      signal
    )
    if (!data.message) throw new Error('Ollama returned an empty response')
    return data.message
  }
}
