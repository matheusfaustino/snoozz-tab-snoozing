import vm from 'vm'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../scripts/settings.js'), 'utf-8')

function makeCtx(urlValue = '', tokenValue = '') {
	const statusEl = { textContent: '', className: '' }
	const ctx = {
		window: {},
		document: {
			getElementById(id) {
				if (id === 'serverUrl') return { value: urlValue }
				if (id === 'serverToken') return { value: tokenValue }
				if (id === 'serverStatus') return statusEl
				return null
			},
			querySelector: () => null,
			querySelectorAll: () => ({ forEach: () => {} }),
		},
		fetch: vi.fn(),
		URL,
		AbortController,
		setTimeout,
		clearTimeout,
		Promise,
	}
	vm.createContext(ctx)
	vm.runInContext(source, ctx)
	return { ctx, statusEl }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('testServerConnection', () => {
	it('shows error when URL field is empty', async () => {
		const { ctx, statusEl } = makeCtx('', '')
		await ctx.testServerConnection()
		expect(statusEl.textContent).toBe('Enter a server URL first')
		expect(statusEl.className).toBe('server-status failed')
		expect(ctx.fetch).not.toHaveBeenCalled()
	})

	it('shows error for invalid URL format', async () => {
		const { ctx, statusEl } = makeCtx('not-a-url', '')
		await ctx.testServerConnection()
		expect(statusEl.textContent).toBe('Invalid URL format')
		expect(statusEl.className).toBe('server-status failed')
		expect(ctx.fetch).not.toHaveBeenCalled()
	})

	it('shows Connected on 200 ok response', async () => {
		const { ctx, statusEl } = makeCtx('https://example.com', 'token')
		ctx.fetch.mockResolvedValue({ ok: true, status: 200 })
		await ctx.testServerConnection()
		expect(statusEl.textContent).toBe('Connected')
		expect(statusEl.className).toBe('server-status connected')
	})

	it('shows Invalid token on 401 response', async () => {
		const { ctx, statusEl } = makeCtx('https://example.com', 'badtoken')
		ctx.fetch.mockResolvedValue({ ok: false, status: 401 })
		await ctx.testServerConnection()
		expect(statusEl.textContent).toBe('Invalid token')
		expect(statusEl.className).toBe('server-status failed')
	})

	it('shows server error code on non-401 failure', async () => {
		const { ctx, statusEl } = makeCtx('https://example.com', '')
		ctx.fetch.mockResolvedValue({ ok: false, status: 503 })
		await ctx.testServerConnection()
		expect(statusEl.textContent).toBe('Server error 503')
		expect(statusEl.className).toBe('server-status failed')
	})

	it('shows Timed out on AbortError', async () => {
		const { ctx, statusEl } = makeCtx('https://example.com', '')
		const err = new Error('Aborted')
		err.name = 'AbortError'
		ctx.fetch.mockRejectedValue(err)
		await ctx.testServerConnection()
		expect(statusEl.textContent).toBe('Timed out')
		expect(statusEl.className).toBe('server-status failed')
	})

	it('shows Could not reach server on network error', async () => {
		const { ctx, statusEl } = makeCtx('https://example.com', '')
		ctx.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
		await ctx.testServerConnection()
		expect(statusEl.textContent).toBe('Could not reach server')
		expect(statusEl.className).toBe('server-status failed')
	})

	it('sends Authorization Bearer header', async () => {
		const { ctx } = makeCtx('https://example.com', 'my-api-token')
		ctx.fetch.mockResolvedValue({ ok: true, status: 200 })
		await ctx.testServerConnection()
		const [, opts] = ctx.fetch.mock.calls[0]
		expect(opts.headers['Authorization']).toBe('Bearer my-api-token')
	})

	it('sends Bearer header even when token is empty', async () => {
		const { ctx } = makeCtx('https://example.com', '')
		ctx.fetch.mockResolvedValue({ ok: true, status: 200 })
		await ctx.testServerConnection()
		const [, opts] = ctx.fetch.mock.calls[0]
		expect(opts.headers['Authorization']).toBe('Bearer ')
	})

	it('POSTs to /api/heartbeat', async () => {
		const { ctx } = makeCtx('https://example.com', 'tok')
		ctx.fetch.mockResolvedValue({ ok: true, status: 200 })
		await ctx.testServerConnection()
		const [url, opts] = ctx.fetch.mock.calls[0]
		expect(url).toBe('https://example.com/api/heartbeat')
		expect(opts.method).toBe('POST')
	})

	it('sends a valid ISO timestamp in the POST body', async () => {
		const { ctx } = makeCtx('https://example.com', 'tok')
		ctx.fetch.mockResolvedValue({ ok: true, status: 200 })
		await ctx.testServerConnection()
		const body = JSON.parse(ctx.fetch.mock.calls[0][1].body)
		expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp)
	})
})
