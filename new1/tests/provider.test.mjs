import test from 'node:test'
import assert from 'node:assert/strict'
import { OllamaProvider } from '../src/provider.mjs'

test('OllamaProvider sends local chat and tool definitions', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify({
      message: { role: 'assistant', content: 'أهلًا من النموذج المحلي' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const provider = new OllamaProvider({ baseUrl: 'http://ollama:11434', model: 'test:local', fetchImpl })
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: {} } }]
  const message = await provider.chat({ messages: [{ role: 'user', content: 'مرحبًا' }], tools })

  assert.equal(message.content, 'أهلًا من النموذج المحلي')
  assert.equal(calls[0].url, 'http://ollama:11434/api/chat')
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.model, 'test:local')
  assert.equal(body.stream, false)
  assert.deepEqual(body.tools, tools)
})

test('OllamaProvider reports an offline service without throwing from health', async () => {
  const provider = new OllamaProvider({
    baseUrl: 'http://offline:11434',
    model: 'test:local',
    fetchImpl: async () => { throw new Error('connection refused') }
  })
  const health = await provider.health()
  assert.equal(health.ok, false)
  assert.equal(health.status, 'offline')
  assert.match(health.error, /ollama serve/)
})
