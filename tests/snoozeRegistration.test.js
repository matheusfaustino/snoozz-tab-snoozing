import vm from 'vm'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const commonSource = readFileSync(resolve(__dirname, '../scripts/common.js'), 'utf-8')
const backgroundSource = readFileSync(resolve(__dirname, '../scripts/background.js'), 'utf-8')

// ─── common.js context for snoozeTab ─────────────────────────────────────────

function makeCommonCtx(opts = {}) {
	const { serverRegisterSnooze = undefined, sendMessage = vi.fn() } = opts
	const tab = { id: 10, url: 'https://example.com', title: 'Example', pinned: false }
	const ctx = {
		window: { gradientSteps: null, sidebar: undefined, matchMedia: () => ({ matches: false }) },
		navigator: { userAgent: '' },
		document: { body: { style: {}, classList: { toggle: vi.fn() } } },
		chrome: {
			storage: { local: { get: vi.fn((k, cb) => cb({})), set: vi.fn((d, cb) => cb && cb()) } },
			tabs: { query: vi.fn((q, cb) => cb([tab])), remove: vi.fn() },
			runtime: { sendMessage },
		},
		dayjs: Object.assign(
			(v) => ({
				valueOf: () => v ? Number(new Date(v)) : Date.now(),
				add: (n, u) => ({ valueOf: () => Date.now() + n * 365 * 24 * 3600 * 1000 }),
				subtract: () => ({ valueOf: () => Date.now() - 10000 }),
				format: () => '',
				isAfter: () => false,
			}),
			{ extend: () => {} }
		),
		Promise,
		setTimeout,
		clearTimeout,
		Date,
	}
	if (serverRegisterSnooze !== undefined) ctx.serverRegisterSnooze = serverRegisterSnooze
	vm.createContext(ctx)
	vm.runInContext(commonSource, ctx)
	return ctx
}

// ─── background.js context for onMessage ─────────────────────────────────────

function makeBackgroundCtx(opts = {}) {
	const { serverRegisterSnooze = vi.fn().mockResolvedValue(null) } = opts
	const messageHandlers = []
	const ctx = {
		chrome: {
			runtime: {
				onMessage:   { addListener: fn => messageHandlers.push(fn) },
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
		getBrowser:              vi.fn().mockReturnValue('chrome'),
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
		serverRegisterSnooze,
		Promise,
		setTimeout,
		clearTimeout,
	}
	ctx._messageHandlers = messageHandlers
	vm.createContext(ctx)
	vm.runInContext(backgroundSource, ctx)
	return ctx
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// ─── snoozeTab — server registration dispatch ─────────────────────────────────

describe('snoozeTab server registration', () => {
	it('calls serverRegisterSnooze directly when it is defined in scope', async () => {
		const serverRegisterSnooze = vi.fn().mockResolvedValue(null)
		const ctx = makeCommonCtx({ serverRegisterSnooze })
		await ctx.snoozeTab(Date.now() + 60000, { id: 1, url: 'https://example.com', title: 'Example' })
		expect(serverRegisterSnooze).toHaveBeenCalledTimes(1)
		const [reg] = serverRegisterSnooze.mock.calls[0]
		expect(reg.url).toBe('https://example.com')
		expect(reg.status).toBe('snoozed')
		expect(typeof reg.id).toBe('string')
		expect(typeof reg.fire_at).toBe('string')
		expect(new Date(reg.fire_at).toISOString()).toBe(reg.fire_at)
		expect(new Date(reg.updated_at).toISOString()).toBe(reg.updated_at)
	})

	it('sends registerSnooze message when serverRegisterSnooze is not in scope', async () => {
		const sendMessage = vi.fn()
		const ctx = makeCommonCtx({ serverRegisterSnooze: undefined, sendMessage })
		await ctx.snoozeTab(Date.now() + 60000, { id: 1, url: 'https://example.com', title: 'Example' })
		const registerCall = sendMessage.mock.calls.find(([msg]) => msg.registerSnooze)
		expect(registerCall).toBeDefined()
		const reg = registerCall[0].registerSnooze
		expect(reg.url).toBe('https://example.com')
		expect(reg.status).toBe('snoozed')
	})

	it('registration payload includes the correct fields', async () => {
		const serverRegisterSnooze = vi.fn().mockResolvedValue(null)
		const wakeUpTime = Date.now() + 3600000
		const ctx = makeCommonCtx({ serverRegisterSnooze })
		await ctx.snoozeTab(wakeUpTime, { id: 1, url: 'https://test.com', title: 'Test' })
		const [reg] = serverRegisterSnooze.mock.calls[0]
		expect(reg).toMatchObject({ url: 'https://test.com', title: 'Test', status: 'snoozed' })
		expect(reg.id).toBeTruthy()
		expect(reg.fire_at).toBeTruthy()
		expect(reg.updated_at).toBeTruthy()
	})

	it('does not call serverRegisterSnooze when tab has no url', async () => {
		const serverRegisterSnooze = vi.fn()
		const ctx = makeCommonCtx({ serverRegisterSnooze })
		await ctx.snoozeTab(Date.now() + 60000, { id: 1, url: '', title: 'No URL' })
		expect(serverRegisterSnooze).not.toHaveBeenCalled()
	})
})

// ─── background onMessage — registerSnooze routing ───────────────────────────

describe('background onMessage registerSnooze', () => {
	it('calls serverRegisterSnooze when registerSnooze message is received', async () => {
		const serverRegisterSnooze = vi.fn().mockResolvedValue(null)
		const ctx = makeBackgroundCtx({ serverRegisterSnooze })
		const reg = { id: 'abc', url: 'https://example.com', title: 'Example', fire_at: '2026-01-01T00:00:00.000Z', status: 'snoozed', updated_at: '2026-01-01T00:00:00.000Z' }
		await ctx._messageHandlers[0]({ registerSnooze: reg })
		expect(serverRegisterSnooze).toHaveBeenCalledWith(reg)
	})

	it('does not call serverRegisterSnooze for other message types', async () => {
		const serverRegisterSnooze = vi.fn().mockResolvedValue(null)
		const ctx = makeBackgroundCtx({ serverRegisterSnooze })
		await ctx._messageHandlers[0]({ wakeUp: true })
		expect(serverRegisterSnooze).not.toHaveBeenCalled()
	})

	it('registers one message handler on load', () => {
		const ctx = makeBackgroundCtx()
		expect(ctx._messageHandlers).toHaveLength(1)
	})
})
