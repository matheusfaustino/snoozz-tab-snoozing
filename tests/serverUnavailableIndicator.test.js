import vm from 'vm'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../scripts/settings.js'), 'utf-8')

const FIFTEEN_MIN = 15 * 60 * 1000

function makeCtx(opts = {}) {
	const { serverUnavailableSince = null } = opts
	const statusEl = { textContent: '', className: '' }
	const ctx = {
		window: {},
		document: {
			getElementById(id) {
				if (id === 'serverStatus') return statusEl
				if (id === 'serverUrl') return { value: '' }
				if (id === 'serverToken') return { value: '' }
				return null
			},
			querySelector: () => null,
			querySelectorAll: () => ({ forEach: () => {} }),
		},
		chrome: {
			storage: {
				local: {
					get: vi.fn((k, cb) => cb({ serverUnavailableSince })),
				},
			},
		},
		fetch: vi.fn(),
		URL, AbortController, setTimeout, clearTimeout, Promise, Date,
	}
	vm.createContext(ctx)
	vm.runInContext(source, ctx)
	return { ctx, statusEl }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('checkServerUnavailableIndicator', () => {
	it('shows warning when server has been unreachable for over 15 minutes', async () => {
		const since = Date.now() - FIFTEEN_MIN - 1000
		const { ctx, statusEl } = makeCtx({ serverUnavailableSince: since })
		await ctx.checkServerUnavailableIndicator({ serverUrl: 'https://example.com' })
		expect(statusEl.textContent).toBe('Server unreachable for over 15 minutes')
		expect(statusEl.className).toBe('server-status failed')
	})

	it('does not show warning when unreachable for less than 15 minutes', async () => {
		const since = Date.now() - FIFTEEN_MIN + 5000
		const { ctx, statusEl } = makeCtx({ serverUnavailableSince: since })
		await ctx.checkServerUnavailableIndicator({ serverUrl: 'https://example.com' })
		expect(statusEl.textContent).toBe('')
	})

	it('does not show warning when serverUnavailableSince is null', async () => {
		const { ctx, statusEl } = makeCtx({ serverUnavailableSince: null })
		await ctx.checkServerUnavailableIndicator({ serverUrl: 'https://example.com' })
		expect(statusEl.textContent).toBe('')
	})

	it('does not show warning when serverUrl is not configured', async () => {
		const since = Date.now() - FIFTEEN_MIN - 1000
		const { ctx, statusEl } = makeCtx({ serverUnavailableSince: since })
		await ctx.checkServerUnavailableIndicator({ serverUrl: '' })
		expect(statusEl.textContent).toBe('')
		expect(ctx.chrome.storage.local.get).not.toHaveBeenCalled()
	})

	it('does not show warning when serverUrl is undefined', async () => {
		const since = Date.now() - FIFTEEN_MIN - 1000
		const { ctx, statusEl } = makeCtx({ serverUnavailableSince: since })
		await ctx.checkServerUnavailableIndicator({})
		expect(statusEl.textContent).toBe('')
	})
})
