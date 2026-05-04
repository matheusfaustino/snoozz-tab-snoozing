import vm from 'vm'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../scripts/serverApi.js'), 'utf-8')

function makeCtx(opts = {}) {
	const defaults = { serverUrl: '', serverToken: '' }
	const cfg = { ...defaults, ...opts }
	const ctx = {
		getOptions: vi.fn().mockResolvedValue(cfg),
		fetch: vi.fn(),
		setTimeout,
		clearTimeout,
		Promise,
	}
	vm.createContext(ctx)
	vm.runInContext(source, ctx)
	return ctx
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// ─── _serverHeaders ──────────────────────────────────────────────────────────

describe('_serverHeaders', () => {
	it('includes Content-Type and Authorization Bearer when token is provided', () => {
		const h = makeCtx()._serverHeaders('secret')
		expect(h['Content-Type']).toBe('application/json')
		expect(h['Authorization']).toBe('Bearer secret')
	})

	it('omits Authorization when token is an empty string', () => {
		const h = makeCtx()._serverHeaders('')
		expect(h['Content-Type']).toBe('application/json')
		expect(h['Authorization']).toBeUndefined()
	})

	it('omits Authorization when token is falsy', () => {
		const ctx = makeCtx()
		expect(ctx._serverHeaders(undefined)['Authorization']).toBeUndefined()
		expect(ctx._serverHeaders(null)['Authorization']).toBeUndefined()
	})
})

// ─── serverHeartbeat ─────────────────────────────────────────────────────────

describe('serverHeartbeat', () => {
	it('returns false and stays unavailable when serverUrl is empty', async () => {
		const ctx = makeCtx()
		expect(await ctx.serverHeartbeat()).toBe(false)
		expect(ctx.isServerAvailable()).toBe(false)
		expect(ctx.fetch).not.toHaveBeenCalled()
	})

	it('returns true and marks server available on ok response', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: 'tok' })
		ctx.fetch.mockResolvedValue({ ok: true })
		expect(await ctx.serverHeartbeat()).toBe(true)
		expect(ctx.isServerAvailable()).toBe(true)
	})

	it('returns false and marks server unavailable on non-ok response', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: 'tok' })
		ctx.fetch.mockResolvedValue({ ok: false, status: 503 })
		expect(await ctx.serverHeartbeat()).toBe(false)
		expect(ctx.isServerAvailable()).toBe(false)
	})

	it('returns false and marks server unavailable on network error', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: 'tok' })
		ctx.fetch.mockRejectedValue(new Error('Network error'))
		expect(await ctx.serverHeartbeat()).toBe(false)
		expect(ctx.isServerAvailable()).toBe(false)
	})

	it('POSTs to /api/heartbeat with Authorization Bearer header', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: 'secret' })
		ctx.fetch.mockResolvedValue({ ok: true })
		await ctx.serverHeartbeat()
		const [url, opts] = ctx.fetch.mock.calls[0]
		expect(url).toBe('https://api.example.com/api/heartbeat')
		expect(opts.method).toBe('POST')
		expect(opts.headers['Authorization']).toBe('Bearer secret')
	})

	it('sends a valid ISO timestamp in the request body', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: '' })
		ctx.fetch.mockResolvedValue({ ok: true })
		await ctx.serverHeartbeat()
		const body = JSON.parse(ctx.fetch.mock.calls[0][1].body)
		expect(typeof body.timestamp).toBe('string')
		expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp)
	})

	it('strips trailing slash from serverUrl', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com/', serverToken: '' })
		ctx.fetch.mockResolvedValue({ ok: true })
		await ctx.serverHeartbeat()
		expect(ctx.fetch.mock.calls[0][0]).toBe('https://api.example.com/api/heartbeat')
	})
})

// ─── _serverRequest (circuit-breaker) ────────────────────────────────────────

describe('_serverRequest', () => {
	it('returns null without fetching when server is unavailable', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: 'tok' })
		expect(await ctx._serverRequest('GET', '/api/snoozes')).toBeNull()
		expect(ctx.fetch).not.toHaveBeenCalled()
	})

	it('returns null when serverUrl is empty', async () => {
		const ctx = makeCtx()
		expect(await ctx._serverRequest('GET', '/api/snoozes')).toBeNull()
	})

	it('returns the response once the server is online', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: 'tok' })
		const mockRes = { ok: true, json: vi.fn().mockResolvedValue([]) }
		ctx.fetch.mockResolvedValue(mockRes)
		await ctx.serverHeartbeat()
		const result = await ctx._serverRequest('GET', '/api/snoozes')
		expect(result).toBe(mockRes)
	})

	it('includes Authorization Bearer header in requests', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: 'mytoken' })
		ctx.fetch.mockResolvedValue({ ok: true })
		await ctx.serverHeartbeat()
		ctx.fetch.mockResolvedValue({ ok: true })
		await ctx._serverRequest('POST', '/api/snooze', { id: '1' })
		const lastOpts = ctx.fetch.mock.calls.at(-1)[1]
		expect(lastOpts.headers['Authorization']).toBe('Bearer mytoken')
	})

	it('serialises the body to JSON', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: 'tok' })
		ctx.fetch.mockResolvedValue({ ok: true })
		await ctx.serverHeartbeat()
		ctx.fetch.mockResolvedValue({ ok: true })
		const payload = { id: 'abc', status: 'snoozed' }
		await ctx._serverRequest('POST', '/api/snooze', payload)
		const lastOpts = ctx.fetch.mock.calls.at(-1)[1]
		expect(JSON.parse(lastOpts.body)).toEqual(payload)
	})

	it('trips circuit breaker on non-2xx response', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: 'tok' })
		ctx.fetch.mockResolvedValue({ ok: true })
		await ctx.serverHeartbeat()
		expect(ctx.isServerAvailable()).toBe(true)
		ctx.fetch.mockResolvedValue({ ok: false, status: 500 })
		expect(await ctx._serverRequest('GET', '/api/snoozes')).toBeNull()
		expect(ctx.isServerAvailable()).toBe(false)
	})

	it('trips circuit breaker on network error', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: 'tok' })
		ctx.fetch.mockResolvedValue({ ok: true })
		await ctx.serverHeartbeat()
		ctx.fetch.mockRejectedValue(new Error('Network gone'))
		await ctx._serverRequest('GET', '/api/snoozes')
		expect(ctx.isServerAvailable()).toBe(false)
	})

	it('heartbeat resets circuit breaker after a failure', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: 'tok' })
		ctx.fetch.mockResolvedValue({ ok: true })
		await ctx.serverHeartbeat()
		ctx.fetch.mockRejectedValue(new Error('gone'))
		await ctx._serverRequest('GET', '/api/snoozes')
		expect(ctx.isServerAvailable()).toBe(false)
		ctx.fetch.mockResolvedValue({ ok: true })
		await ctx.serverHeartbeat()
		expect(ctx.isServerAvailable()).toBe(true)
	})
})

// ─── isServerAvailable ───────────────────────────────────────────────────────

describe('isServerAvailable', () => {
	it('returns false by default', () => {
		expect(makeCtx().isServerAvailable()).toBe(false)
	})

	it('returns true after a successful heartbeat', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: '' })
		ctx.fetch.mockResolvedValue({ ok: true })
		await ctx.serverHeartbeat()
		expect(ctx.isServerAvailable()).toBe(true)
	})

	it('returns false after a failed heartbeat', async () => {
		const ctx = makeCtx({ serverUrl: 'https://api.example.com', serverToken: '' })
		ctx.fetch.mockResolvedValue({ ok: false, status: 500 })
		await ctx.serverHeartbeat()
		expect(ctx.isServerAvailable()).toBe(false)
	})
})
