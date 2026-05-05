import vm from 'vm'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const commonSource     = readFileSync(resolve(__dirname, '../scripts/common.js'), 'utf-8')
const backgroundSource = readFileSync(resolve(__dirname, '../scripts/background.js'), 'utf-8')

// ─── common.js context ───────────────────────────────────────────────────────

function makeCommonCtx(opts = {}) {
	const { serverRegisterSnooze = vi.fn() } = opts
	const storedSets = []
	const ctx = {
		window: { gradientSteps: null, sidebar: undefined, matchMedia: () => ({ matches: false }) },
		navigator: { userAgent: '' },
		document: { body: { style: {}, classList: { toggle: vi.fn() } } },
		chrome: {
			storage: {
				local: {
					get: vi.fn((k, cb) => cb({})),
					set: vi.fn((d, cb) => { storedSets.push(d); cb && cb() }),
				},
			},
			tabs: { query: vi.fn((q, cb) => cb([{ id: 10, url: 'https://example.com', title: 'Example', pinned: false }])) },
			runtime: { sendMessage: vi.fn() },
		},
		dayjs: Object.assign(
			(v) => ({
				valueOf: () => v ? Number(new Date(v)) : Date.now(),
				add: (n) => ({ valueOf: () => Date.now() + n * 365 * 24 * 3600 * 1000 }),
				subtract: () => ({ valueOf: () => Date.now() - 10000 }),
				format: () => '',
				isAfter: () => false,
			}),
			{ extend: () => {} }
		),
		Promise, setTimeout, clearTimeout, Date,
	}
	if (serverRegisterSnooze !== undefined) ctx.serverRegisterSnooze = serverRegisterSnooze
	ctx._storedSets = storedSets
	vm.createContext(ctx)
	vm.runInContext(commonSource, ctx)
	return ctx
}

// ─── background.js context ───────────────────────────────────────────────────

function makeBackgroundCtx(opts = {}) {
	const { serverGetSnooze = vi.fn().mockResolvedValue(null) } = opts
	const ctx = {
		chrome: {
			runtime: {
				onMessage:   { addListener: vi.fn() },
				onInstalled: { addListener: vi.fn() },
				onStartup:   { addListener: vi.fn() },
				setUninstallURL: vi.fn(), sendMessage: vi.fn(),
				getManifest: vi.fn().mockReturnValue({ version: '2.0' }),
			},
			storage: {
				onChanged: { addListener: vi.fn() },
				local: { get: vi.fn((k, cb) => cb({})), set: vi.fn((d, cb) => cb && cb()) },
			},
			alarms:  { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: vi.fn() } },
			notifications: null,
			commands: { onCommand: { addListener: vi.fn() }, getAll: vi.fn(cb => cb([])) },
			contextMenus: {
				create: vi.fn(), removeAll: vi.fn(), update: vi.fn(), refresh: vi.fn(),
				onClicked: { addListener: vi.fn() }, onShown: { addListener: vi.fn() },
			},
			tabs: {
				query: vi.fn((q, cb) => cb && cb([])),
				create: vi.fn(), update: vi.fn(), remove: vi.fn(),
				onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
				onActivated: { addListener: vi.fn() },
			},
			windows: { getAll: vi.fn((o, cb) => cb && cb([])), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
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
		DEFAULT_OPTIONS: {}, getChoices: vi.fn().mockResolvedValue({}),
		isDefault: vi.fn().mockReturnValue(false), isValid: vi.fn().mockReturnValue(true),
		formatSnoozedUntil: vi.fn().mockReturnValue(''), getTabCountLabel: vi.fn().mockReturnValue(''),
		getSiteCountLabel: vi.fn().mockReturnValue(''), getHostname: vi.fn().mockReturnValue(''),
		setTheme: vi.fn().mockResolvedValue(undefined), fetchHourFormat: vi.fn().mockResolvedValue(undefined),
		updateBadge: vi.fn().mockResolvedValue(undefined), poll: vi.fn(),
		dayjs: vi.fn().mockReturnValue({ subtract: () => ({ valueOf: () => 0 }), valueOf: () => 0 }),
		serverHeartbeat:      vi.fn().mockResolvedValue(true),
		isServerAvailable:    vi.fn().mockReturnValue(false),
		serverGetAllSnoozes:  vi.fn().mockResolvedValue([]),
		serverRegisterSnooze: vi.fn().mockResolvedValue(null),
		serverUpdateSnooze:   vi.fn().mockResolvedValue(null),
		serverGetSnooze,
		Promise, setTimeout, clearTimeout, Date,
	}
	vm.createContext(ctx)
	vm.runInContext(backgroundSource, ctx)
	return ctx
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// ─── T7: snoozeTab stores updated_at locally ─────────────────────────────────

describe('snoozeTab updated_at', () => {
	it('saves updated_at on the local snooze record', async () => {
		const ctx = makeCommonCtx()
		await ctx.snoozeTab(Date.now() + 60000, { id: 1, url: 'https://example.com', title: 'Test' })
		const snoozedCall = ctx._storedSets.find(d => d.snoozed)
		expect(snoozedCall).toBeDefined()
		const saved = snoozedCall.snoozed[0]
		expect(typeof saved.updated_at).toBe('string')
		expect(new Date(saved.updated_at).toISOString()).toBe(saved.updated_at)
	})

	it('uses the same updated_at value in the server registration payload', async () => {
		const serverRegisterSnooze = vi.fn()
		const ctx = makeCommonCtx({ serverRegisterSnooze })
		await ctx.snoozeTab(Date.now() + 60000, { id: 1, url: 'https://example.com', title: 'Test' })
		const snoozedCall = ctx._storedSets.find(d => d.snoozed)
		const localUpdatedAt = snoozedCall.snoozed[0].updated_at
		const [reg] = serverRegisterSnooze.mock.calls[0]
		expect(reg.updated_at).toBe(localUpdatedAt)
	})
})

// ─── T7: wakeMeUp updates updated_at on state change ─────────────────────────

describe('wakeMeUp updated_at', () => {
	it('sets updated_at on a tab when it wakes up', async () => {
		const ctx = makeBackgroundCtx()
		const tab = { id: 'tab1', url: 'https://example.com', wakeUpTime: Date.now() - 1000, paused: false }
		ctx.dayjs = vi.fn().mockReturnValue({ valueOf: () => Date.now() })
		await ctx.wakeMeUp([tab])
		const [saved] = ctx.saveTabs.mock.calls[0][0]
		expect(typeof saved.updated_at).toBe('string')
		expect(new Date(saved.updated_at).toISOString()).toBe(saved.updated_at)
	})

	it('sets updated_at on a repeat tab when it is rescheduled', async () => {
		const nextTime = Date.now() + 86400000
		const ctx = makeBackgroundCtx()
		ctx.calculateNextSnoozeTime = vi.fn().mockResolvedValue({ valueOf: () => nextTime })
		const tab = { id: 'tab1', url: 'https://example.com', wakeUpTime: Date.now() - 1000, paused: false, repeat: { type: 'daily' } }
		ctx.dayjs = vi.fn().mockReturnValue({ valueOf: () => Date.now() })
		await ctx.wakeMeUp([tab])
		const [saved] = ctx.saveTabs.mock.calls[0][0]
		expect(typeof saved.updated_at).toBe('string')
		expect(new Date(saved.updated_at).toISOString()).toBe(saved.updated_at)
	})
})
