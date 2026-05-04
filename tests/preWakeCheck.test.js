import vm from 'vm'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../scripts/background.js'), 'utf-8')

function makeCtx(opts = {}) {
	const { serverGetSnooze = vi.fn().mockResolvedValue(null) } = opts

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
				create: vi.fn(),
				clear:  vi.fn(),
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
		getSnoozedTabs:          vi.fn().mockResolvedValue([]),
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
		isServerAvailable:       vi.fn().mockReturnValue(false),
		serverGetSnooze,
		Promise,
		setTimeout,
		clearTimeout,
	}

	vm.createContext(ctx)
	vm.runInContext(source, ctx)
	return ctx
}

function makeSleepyTab(id, overrides = {}) {
	return {
		id,
		url: `https://example.com/${id}`,
		title: `Tab ${id}`,
		wakeUpTime: Date.now() - 1000,
		paused: false,
		opened: undefined,
		...overrides,
	}
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// ─── wakeMeUp — pre-wake server check ────────────────────────────────────────

describe('wakeMeUp pre-wake server check', () => {
	it('opens a tab when server returns status snoozed', async () => {
		const serverGetSnooze = vi.fn().mockResolvedValue({ id: 'tab1', status: 'snoozed' })
		const ctx = makeCtx({ serverGetSnooze })
		const tab = makeSleepyTab('tab1')
		ctx.dayjs = vi.fn().mockReturnValue({ valueOf: () => Date.now(), subtract: () => ({ valueOf: () => 0 }) })
		await ctx.wakeMeUp([tab])
		expect(ctx.openTab).toHaveBeenCalledTimes(1)
	})

	it('skips a tab when server returns status dismissed', async () => {
		const serverGetSnooze = vi.fn().mockResolvedValue({ id: 'tab1', status: 'dismissed' })
		const ctx = makeCtx({ serverGetSnooze })
		const tab = makeSleepyTab('tab1')
		ctx.dayjs = vi.fn().mockReturnValue({ valueOf: () => Date.now(), subtract: () => ({ valueOf: () => 0 }) })
		await ctx.wakeMeUp([tab])
		expect(ctx.openTab).not.toHaveBeenCalled()
	})

	it('skips a tab when server returns status fired', async () => {
		const serverGetSnooze = vi.fn().mockResolvedValue({ id: 'tab1', status: 'fired' })
		const ctx = makeCtx({ serverGetSnooze })
		const tab = makeSleepyTab('tab1')
		ctx.dayjs = vi.fn().mockReturnValue({ valueOf: () => Date.now(), subtract: () => ({ valueOf: () => 0 }) })
		await ctx.wakeMeUp([tab])
		expect(ctx.openTab).not.toHaveBeenCalled()
	})

	it('opens a tab when server returns null (unavailable or timeout)', async () => {
		const serverGetSnooze = vi.fn().mockResolvedValue(null)
		const ctx = makeCtx({ serverGetSnooze })
		const tab = makeSleepyTab('tab1')
		ctx.dayjs = vi.fn().mockReturnValue({ valueOf: () => Date.now(), subtract: () => ({ valueOf: () => 0 }) })
		await ctx.wakeMeUp([tab])
		expect(ctx.openTab).toHaveBeenCalledTimes(1)
	})

	it('checks each tab individually against the server', async () => {
		const serverGetSnooze = vi.fn()
			.mockResolvedValueOnce({ id: 'tab1', status: 'snoozed' })
			.mockResolvedValueOnce({ id: 'tab2', status: 'dismissed' })
			.mockResolvedValueOnce({ id: 'tab3', status: 'snoozed' })
		const ctx = makeCtx({ serverGetSnooze })
		const tabs = [makeSleepyTab('tab1'), makeSleepyTab('tab2'), makeSleepyTab('tab3')]
		ctx.dayjs = vi.fn().mockReturnValue({ valueOf: () => Date.now(), subtract: () => ({ valueOf: () => 0 }) })
		await ctx.wakeMeUp(tabs)
		expect(serverGetSnooze).toHaveBeenCalledTimes(3)
		expect(ctx.openTab).toHaveBeenCalledTimes(2)
	})

	it('skips server check entirely and opens tab when all tabs are already past due and serverGetSnooze not needed', async () => {
		const serverGetSnooze = vi.fn().mockResolvedValue(null)
		const ctx = makeCtx({ serverGetSnooze })
		const tab = makeSleepyTab('tab1', { opened: 12345 })
		ctx.dayjs = vi.fn().mockReturnValue({ valueOf: () => Date.now(), subtract: () => ({ valueOf: () => 0 }) })
		await ctx.wakeMeUp([tab])
		expect(serverGetSnooze).not.toHaveBeenCalled()
		expect(ctx.openTab).not.toHaveBeenCalled()
	})
})
