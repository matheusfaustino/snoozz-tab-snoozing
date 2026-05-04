import vm from 'vm'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../scripts/background.js'), 'utf-8')

function makeCtx(serverHeartbeatMock = vi.fn().mockResolvedValue(true)) {
	const alarmHandlers = []

	const ctx = {
		// ── Chrome APIs ─────────────────────────────────────────────────────
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
				onAlarm: { addListener: fn => alarmHandlers.push(fn) },
			},
			notifications: null,
			commands: {
				onCommand:  { addListener: vi.fn() },
				getAll: vi.fn(cb => cb([])),
			},
			contextMenus: {
				create:    vi.fn(),
				removeAll: vi.fn(),
				update:    vi.fn(),
				refresh:   vi.fn(),
				onClicked: { addListener: vi.fn() },
				onShown:   { addListener: vi.fn() },
			},
			tabs: {
				query:  vi.fn((q, cb) => cb && cb([])),
				create: vi.fn(),
				update: vi.fn(),
				remove: vi.fn(),
				onUpdated:   { addListener: vi.fn(), removeListener: vi.fn() },
				onActivated: { addListener: vi.fn() },
			},
			windows: {
				getAll:  vi.fn((o, cb) => cb && cb([])),
				create:  vi.fn(),
				update:  vi.fn(),
				remove:  vi.fn(),
			},
			idle:      { onStateChanged: { addListener: vi.fn() } },
			extension: { isAllowedIncognitoAccess: vi.fn(cb => cb(false)) },
			browserAction: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
		},
		navigator: { onLine: true },

		// ── common.js stubs ──────────────────────────────────────────────────
		getSnoozedTabs:         vi.fn().mockResolvedValue([]),
		saveTabs:               vi.fn().mockResolvedValue(undefined),
		saveOptions:            vi.fn().mockResolvedValue(undefined),
		getOptions:             vi.fn().mockResolvedValue(undefined),
		sleeping:               vi.fn(t => t),
		getAllWindows:           vi.fn().mockResolvedValue([]),
		getTabsInWindow:        vi.fn().mockResolvedValue([]),
		findTabAnywhere:        vi.fn().mockResolvedValue(null),
		createAlarm:            vi.fn().mockResolvedValue(undefined),
		createNotification:     vi.fn(),
		createWindow:           vi.fn().mockResolvedValue({}),
		openTab:                vi.fn().mockResolvedValue(undefined),
		openWindow:             vi.fn().mockResolvedValue(undefined),
		openSelection:          vi.fn().mockResolvedValue(undefined),
		openExtensionTab:       vi.fn(),
		snoozeTab:              vi.fn().mockResolvedValue({}),
		bgLog:                  vi.fn(),
		getBrowser:             vi.fn().mockReturnValue('chrome'),
		calculateNextSnoozeTime:vi.fn().mockResolvedValue(Date.now() + 60000),
		upgradeSettings:        vi.fn(s => s || {}),
		DEFAULT_OPTIONS:        {},
		getChoices:             vi.fn().mockResolvedValue({}),
		isDefault:              vi.fn().mockReturnValue(false),
		isValid:                vi.fn().mockReturnValue(true),
		formatSnoozedUntil:     vi.fn().mockReturnValue(''),
		getTabCountLabel:       vi.fn().mockReturnValue(''),
		getSiteCountLabel:      vi.fn().mockReturnValue(''),
		getHostname:            vi.fn().mockReturnValue(''),
		setTheme:               vi.fn().mockResolvedValue(undefined),
		fetchHourFormat:        vi.fn().mockResolvedValue(undefined),
		updateBadge:            vi.fn().mockResolvedValue(undefined),
		poll:                   vi.fn(),
		dayjs:                  vi.fn().mockReturnValue({ subtract: () => ({ valueOf: () => 0 }), valueOf: () => 0 }),

		// ── serverApi.js stubs ───────────────────────────────────────────────
		serverHeartbeat:   serverHeartbeatMock,
		isServerAvailable: vi.fn().mockReturnValue(false),

		// ── Node built-ins ───────────────────────────────────────────────────
		Promise,
		setTimeout,
		clearTimeout,
	}

	ctx._alarmHandlers = alarmHandlers
	vm.createContext(ctx)
	vm.runInContext(source, ctx)
	return ctx
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// ─── alarm handler routing ────────────────────────────────────────────────────

describe('alarm handler', () => {
	it('calls serverHeartbeat when the serverHeartbeat alarm fires', async () => {
		const heartbeatMock = vi.fn().mockResolvedValue(true)
		const ctx = makeCtx(heartbeatMock)
		await ctx._alarmHandlers[0]({ name: 'serverHeartbeat' })
		expect(heartbeatMock).toHaveBeenCalledTimes(1)
	})

	it('does not call serverHeartbeat for other alarms', async () => {
		const heartbeatMock = vi.fn().mockResolvedValue(true)
		const ctx = makeCtx(heartbeatMock)
		await ctx._alarmHandlers[0]({ name: 'wakeUpTabs' })
		expect(heartbeatMock).not.toHaveBeenCalled()
	})

	it('registers exactly one alarm handler on load', () => {
		const ctx = makeCtx()
		expect(ctx._alarmHandlers).toHaveLength(1)
	})
})

// ─── startup behaviour ────────────────────────────────────────────────────────

describe('init', () => {
	it('creates a repeating 5-minute serverHeartbeat alarm', async () => {
		const ctx = makeCtx()
		await ctx.init()
		expect(ctx.chrome.alarms.create).toHaveBeenCalledWith(
			'serverHeartbeat',
			{ periodInMinutes: 5 }
		)
	})

	it('fires an initial heartbeat on startup', async () => {
		const heartbeatMock = vi.fn().mockResolvedValue(true)
		const ctx = makeCtx(heartbeatMock)
		await ctx.init()
		expect(heartbeatMock).toHaveBeenCalledTimes(1)
	})

	it('fires the heartbeat before processing pending wakes', async () => {
		const order = []
		const heartbeatMock = vi.fn().mockImplementation(async () => { order.push('heartbeat'); return true })
		const ctx = makeCtx(heartbeatMock)
		ctx.wakeUpTask = vi.fn().mockImplementation(async () => order.push('wakeUp'))
		await ctx.init()
		expect(order.indexOf('heartbeat')).toBeLessThan(order.indexOf('wakeUp'))
	})
})
