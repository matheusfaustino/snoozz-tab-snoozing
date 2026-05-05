import vm from 'vm'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../scripts/background.js'), 'utf-8')

function makeCtx(opts = {}) {
	const {
		serverAvailable = true,
		serverSnoozes = [],
		localTabs = [],
	} = opts

	const ctx = {
		chrome: {
			runtime: {
				onMessage:   { addListener: vi.fn() },
				onInstalled: { addListener: vi.fn() },
				onStartup:   { addListener: vi.fn() },
				setUninstallURL: vi.fn(),
				sendMessage: vi.fn(),
				getManifest: vi.fn().mockReturnValue({ version: '2.0' }),
			},
			storage: {
				onChanged: { addListener: vi.fn() },
				local: { get: vi.fn((k, cb) => cb({})), set: vi.fn((d, cb) => cb && cb()) },
			},
			alarms: {
				create: vi.fn(), clear: vi.fn(),
				onAlarm: { addListener: vi.fn() },
			},
			notifications: null,
			commands: { onCommand: { addListener: vi.fn() }, getAll: vi.fn(cb => cb([])) },
			contextMenus: {
				create: vi.fn(), removeAll: vi.fn(), update: vi.fn(), refresh: vi.fn(),
				onClicked: { addListener: vi.fn() },
				onShown:   { addListener: vi.fn() },
			},
			tabs: {
				query:  vi.fn((q, cb) => cb && cb([])),
				create: vi.fn(), update: vi.fn(), remove: vi.fn(),
				onUpdated:   { addListener: vi.fn(), removeListener: vi.fn() },
				onActivated: { addListener: vi.fn() },
			},
			windows: {
				getAll: vi.fn((o, cb) => cb && cb([])),
				create: vi.fn(), update: vi.fn(), remove: vi.fn(),
			},
			idle:      { onStateChanged: { addListener: vi.fn() } },
			extension: { isAllowedIncognitoAccess: vi.fn(cb => cb(false)) },
			browserAction: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
		},
		navigator: { onLine: true },
		getSnoozedTabs:          vi.fn().mockResolvedValue(localTabs),
		saveTabs:                vi.fn().mockResolvedValue(undefined),
		saveOptions:             vi.fn().mockResolvedValue(undefined),
		getOptions:              vi.fn().mockResolvedValue(undefined),
		sleeping:                vi.fn(t => t),
		getAllWindows:            vi.fn().mockResolvedValue([]),
		getTabsInWindow:         vi.fn().mockResolvedValue([]),
		findTabAnywhere:         vi.fn().mockResolvedValue(null),
		createAlarm:             vi.fn().mockResolvedValue(undefined),
		createNotification:      vi.fn(),
		createWindow:            vi.fn().mockResolvedValue({}),
		openTab:                 vi.fn().mockResolvedValue(undefined),
		openWindow:              vi.fn().mockResolvedValue(undefined),
		openSelection:           vi.fn().mockResolvedValue(undefined),
		openExtensionTab:        vi.fn(),
		snoozeTab:               vi.fn().mockResolvedValue({}),
		bgLog:                   vi.fn(),
		getBrowser:              vi.fn().mockReturnValue('firefox'),
		calculateNextSnoozeTime: vi.fn().mockResolvedValue(Date.now() + 60000),
		upgradeSettings:         vi.fn(s => s || {}),
		DEFAULT_OPTIONS:         {},
		getChoices:              vi.fn().mockResolvedValue({}),
		isDefault:               vi.fn().mockReturnValue(false),
		isValid:                 vi.fn().mockReturnValue(true),
		formatSnoozedUntil:      vi.fn().mockReturnValue(''),
		getTabCountLabel:        vi.fn().mockReturnValue(''),
		getSiteCountLabel:       vi.fn().mockReturnValue(''),
		getHostname:             vi.fn().mockReturnValue(''),
		setTheme:                vi.fn().mockResolvedValue(undefined),
		fetchHourFormat:         vi.fn().mockResolvedValue(undefined),
		updateBadge:             vi.fn().mockResolvedValue(undefined),
		poll:                    vi.fn(),
		dayjs:                   vi.fn().mockReturnValue({ subtract: () => ({ valueOf: () => 0 }), valueOf: () => 0 }),
		serverHeartbeat:         vi.fn().mockResolvedValue(true),
		isServerAvailable:       vi.fn().mockReturnValue(serverAvailable),
		serverGetAllSnoozes:     vi.fn().mockResolvedValue(serverSnoozes),
		serverRegisterSnooze:    vi.fn().mockResolvedValue(null),
		serverUpdateSnooze:      vi.fn().mockResolvedValue(null),
		serverGetSnooze:         vi.fn().mockResolvedValue(null),
		Promise,
		setTimeout,
		clearTimeout,
		Date,
	}

	vm.createContext(ctx)
	vm.runInContext(source, ctx)
	return ctx
}

function serverRec(overrides = {}) {
	return {
		id: 'rec1',
		url: 'https://example.com',
		title: 'Example',
		fire_at: new Date(Date.now() + 3600000).toISOString(),
		status: 'snoozed',
		updated_at: '2026-01-02T00:00:00.000Z',
		...overrides,
	}
}

function localTab(overrides = {}) {
	return {
		id: 'rec1',
		url: 'https://example.com',
		title: 'Example',
		wakeUpTime: Date.now() + 3600000,
		timeCreated: Date.now(),
		updated_at: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// ─── guard conditions ─────────────────────────────────────────────────────────

describe('syncWithServer guard conditions', () => {
	it('returns early without fetching when server is unavailable', async () => {
		const ctx = makeCtx({ serverAvailable: false })
		await ctx.syncWithServer()
		expect(ctx.serverGetAllSnoozes).not.toHaveBeenCalled()
	})

	it('does nothing when both server and local have no records', async () => {
		const ctx = makeCtx({ serverSnoozes: [], localTabs: [] })
		await ctx.syncWithServer()
		expect(ctx.saveTabs).not.toHaveBeenCalled()
		expect(ctx.serverRegisterSnooze).not.toHaveBeenCalled()
		expect(ctx.serverUpdateSnooze).not.toHaveBeenCalled()
	})
})

// ─── server-only records ──────────────────────────────────────────────────────

describe('syncWithServer server-only records', () => {
	it('creates a local record for a server-only snoozed entry', async () => {
		const sr = serverRec({ id: 'new1', status: 'snoozed' })
		const ctx = makeCtx({ serverSnoozes: [sr], localTabs: [] })
		await ctx.syncWithServer()
		const [saved] = ctx.saveTabs.mock.calls[0][0]
		expect(saved.id).toBe('new1')
		expect(saved.url).toBe(sr.url)
		expect(saved.opened).toBeUndefined()
	})

	it('marks a server-only dismissed entry as opened locally', async () => {
		const sr = serverRec({ id: 'done1', status: 'dismissed' })
		const ctx = makeCtx({ serverSnoozes: [sr], localTabs: [] })
		await ctx.syncWithServer()
		const [saved] = ctx.saveTabs.mock.calls[0][0]
		expect(saved.id).toBe('done1')
		expect(saved.opened).toBeTruthy()
	})

	it('calls saveTabs when a server-only record is added locally', async () => {
		const ctx = makeCtx({ serverSnoozes: [serverRec()], localTabs: [] })
		await ctx.syncWithServer()
		expect(ctx.saveTabs).toHaveBeenCalledTimes(1)
	})
})

// ─── local-only records ───────────────────────────────────────────────────────

describe('syncWithServer local-only records', () => {
	it('POSTs local-only record to server', async () => {
		const lt = localTab({ id: 'local1' })
		const ctx = makeCtx({ serverSnoozes: [], localTabs: [lt] })
		await ctx.syncWithServer()
		expect(ctx.serverRegisterSnooze).toHaveBeenCalledTimes(1)
		const [payload] = ctx.serverRegisterSnooze.mock.calls[0]
		expect(payload.id).toBe('local1')
		expect(payload.url).toBe(lt.url)
		expect(payload.status).toBe('snoozed')
	})

	it('sends status dismissed for a local tab that has been opened', async () => {
		const lt = localTab({ id: 'done1', opened: Date.now() - 1000 })
		const ctx = makeCtx({ serverSnoozes: [], localTabs: [lt] })
		await ctx.syncWithServer()
		const [payload] = ctx.serverRegisterSnooze.mock.calls[0]
		expect(payload.status).toBe('dismissed')
	})

	it('does not call saveTabs for local-only push (no local state change)', async () => {
		const ctx = makeCtx({ serverSnoozes: [], localTabs: [localTab()] })
		await ctx.syncWithServer()
		expect(ctx.saveTabs).not.toHaveBeenCalled()
	})
})

// ─── conflict resolution — server newer ──────────────────────────────────────

describe('syncWithServer server-newer conflict', () => {
	it('applies server fire_at when server updated_at is newer', async () => {
		const newFireAt = new Date(Date.now() + 7200000).toISOString()
		const sr = serverRec({ updated_at: '2026-01-03T00:00:00.000Z', fire_at: newFireAt })
		const lt = localTab({ updated_at: '2026-01-01T00:00:00.000Z' })
		const ctx = makeCtx({ serverSnoozes: [sr], localTabs: [lt] })
		await ctx.syncWithServer()
		const [saved] = ctx.saveTabs.mock.calls[0][0]
		expect(saved.wakeUpTime).toBe(new Date(newFireAt).valueOf())
	})

	it('marks local tab as opened when server reports dismissed and server is newer', async () => {
		const sr = serverRec({ status: 'dismissed', updated_at: '2026-01-03T00:00:00.000Z' })
		const lt = localTab({ updated_at: '2026-01-01T00:00:00.000Z' })
		const ctx = makeCtx({ serverSnoozes: [sr], localTabs: [lt] })
		await ctx.syncWithServer()
		const [saved] = ctx.saveTabs.mock.calls[0][0]
		expect(saved.opened).toBeTruthy()
	})

	it('clears local opened when server reports snoozed and server is newer', async () => {
		const sr = serverRec({ status: 'snoozed', updated_at: '2026-01-03T00:00:00.000Z' })
		const lt = localTab({ updated_at: '2026-01-01T00:00:00.000Z', opened: Date.now() - 1000 })
		const ctx = makeCtx({ serverSnoozes: [sr], localTabs: [lt] })
		await ctx.syncWithServer()
		const [saved] = ctx.saveTabs.mock.calls[0][0]
		expect(saved.opened).toBeUndefined()
	})

	it('does not call serverUpdateSnooze when server is newer', async () => {
		const sr = serverRec({ updated_at: '2026-01-03T00:00:00.000Z' })
		const lt = localTab({ updated_at: '2026-01-01T00:00:00.000Z' })
		const ctx = makeCtx({ serverSnoozes: [sr], localTabs: [lt] })
		await ctx.syncWithServer()
		expect(ctx.serverUpdateSnooze).not.toHaveBeenCalled()
	})
})

// ─── conflict resolution — local newer ───────────────────────────────────────

describe('syncWithServer local-newer conflict', () => {
	it('PATCHes server when local updated_at is newer', async () => {
		const sr = serverRec({ updated_at: '2026-01-01T00:00:00.000Z' })
		const lt = localTab({ updated_at: '2026-01-03T00:00:00.000Z' })
		const ctx = makeCtx({ serverSnoozes: [sr], localTabs: [lt] })
		await ctx.syncWithServer()
		expect(ctx.serverUpdateSnooze).toHaveBeenCalledTimes(1)
		const [id, payload] = ctx.serverUpdateSnooze.mock.calls[0]
		expect(id).toBe(lt.id)
		expect(payload.url).toBe(lt.url)
		expect(payload.updated_at).toBe(lt.updated_at)
	})

	it('does not call saveTabs when only pushing local state to server', async () => {
		const sr = serverRec({ updated_at: '2026-01-01T00:00:00.000Z' })
		const lt = localTab({ updated_at: '2026-01-03T00:00:00.000Z' })
		const ctx = makeCtx({ serverSnoozes: [sr], localTabs: [lt] })
		await ctx.syncWithServer()
		expect(ctx.saveTabs).not.toHaveBeenCalled()
	})

	it('skips push when local has no updated_at', async () => {
		const sr = serverRec({ updated_at: '2026-01-01T00:00:00.000Z' })
		const lt = localTab({ updated_at: undefined })
		const ctx = makeCtx({ serverSnoozes: [sr], localTabs: [lt] })
		await ctx.syncWithServer()
		expect(ctx.serverUpdateSnooze).not.toHaveBeenCalled()
	})
})
