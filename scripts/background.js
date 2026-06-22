chrome.runtime.onMessage.addListener(async msg => {
	if (msg.logOptions) sendToLogs(msg.logOptions);
	if (msg.wakeUp) await wakeUpTask();
	if (msg.close) setTimeout(_ => {
		if (msg.tabId) chrome.tabs.remove(msg.tabId);
		if (msg.windowId) chrome.windows.remove(msg.windowId);
		chrome.runtime.sendMessage({ closePopup: true });
	}, msg.delay || 2000);
});
chrome.storage.onChanged.addListener(async changes => {
	if (changes.snoozedOptions) {
		await setUpContextMenus(changes.snoozedOptions.newValue.contextMenu);
		updateBadge(null, changes.snoozedOptions.newValue.badge);
		if (changes.snoozedOptions.oldValue && changes.snoozedOptions.newValue.history !== changes.snoozedOptions.oldValue.history) await wakeUpTask();
		var oldCouchdb = changes.snoozedOptions.oldValue && changes.snoozedOptions.oldValue.couchdb;
		var newCouchdb = changes.snoozedOptions.newValue.couchdb;
		if (JSON.stringify(oldCouchdb) !== JSON.stringify(newCouchdb)) await setupCouchSync();
	}
});

localDB.changes({ live: true, since: 'now', include_docs: false })
	.on('change', async _ => {
		var tabs = await getSnoozedTabs();
		await updateBadge(tabs);
		await wakeUpTask(tabs);
		try { chrome.runtime.sendMessage({ updateDash: true }); } catch (e) { }
	});

if (chrome.notifications) chrome.notifications.onClicked.addListener(async id => {
	await chrome.notifications.clear(id)
	if (id === '_wakeUpNow') return await wakeUpTask();
	var t = await getSnoozedTabs(id);
	if (t && t.id && id && id.length) {
		var found = t.tabs ? await findTabAnywhere(null, t.id) : await findTabAnywhere(t.url);
		if (found && found.id && found.windowId) {
			try {
				await chrome.windows.update(found.windowId, { focused: true });
				if (t.tabs) {
					var winTabs = await getTabsInWindow();
					await chrome.tabs.update(winTabs[0] && winTabs[0].id ? winTabs[0].id : found.id, { active: true });
				} else {
					await chrome.tabs.update(found.id, { active: true });
				}
				return;
			} catch (e) { }
		}
	}
	await openExtensionTab('html/nap-room.html');
});

async function wakeUpTask(cachedTabs) {
	var tabs = cachedTabs || await getSnoozedTabs();
	if (!tabs || !tabs.length || tabs.length === 0) return;
	await cleanUpHistory(tabs);
	if (sleeping(tabs).length === 0) {
		bgLog(['No tabs are asleep'], ['pink'], 'pink');
		return chrome.alarms.clear('wakeUpTabs');
	}
	await setNextAlarm(tabs);
}

var debounce;
async function setNextAlarm(tabs) {
	var myDevice = await getDeviceName();
	var next = sleeping(tabs).filter(t => t.wakeUpTime && !t.paused && (!t.targetDevice || t.targetDevice === myDevice));
	next = next.length ? next.reduce((t1, t2) => t1.wakeUpTime < t2.wakeUpTime ? t1 : t2) : undefined;
	if (!next) return;
	if (next.wakeUpTime <= dayjs().valueOf()) {
		clearTimeout(debounce)
		debounce = setTimeout(_ => wakeMeUp(tabs), 3000)
	} else {
		var oneHour = dayjs().add(1, 'h').valueOf();
		bgLog(['Next tab waking up:', next.id, 'at', dayjs(next.wakeUpTime).format('HH:mm:ss DD/MM/YY')], ['', 'green', '', 'yellow'])
		await createAlarm(next.wakeUpTime < oneHour ? next.wakeUpTime : oneHour, next.wakeUpTime < oneHour);
	}
}

async function wakeMeUp(tabs) {
	var now = dayjs().valueOf();
	var myDevice = await getDeviceName();
	var wakingUp = t => !t.paused && !t.opened && (t.url || (t.tabs && t.tabs.length && t.tabs.length > 0)) && t.wakeUpTime && t.wakeUpTime <= now && (!t.targetDevice || t.targetDevice === myDevice);
	if (!tabs.some(wakingUp)) return;
	// Re-read from PouchDB to pick up any state pulled from remote since tabs was loaded,
	// preventing a tab from being opened twice if another device already woke it.
	var freshTabs = await getSnoozedTabs();
	var toOpen = freshTabs.filter(wakingUp);
	if (toOpen.length === 0) return;
	bgLog(['Waking up tabs', toOpen.map(t => t.id).join(', ')], ['', 'green'], 'yellow');
	freshTabs.filter(wakingUp).filter(t => !t.repeat).forEach(t => t.opened = now);
	for (var s of freshTabs.filter(wakingUp).filter(t => t.repeat)) {
		var next = await calculateNextSnoozeTime(s.repeat);
		s.wakeUpTime = next.valueOf();
	}
	await saveTabs(freshTabs);

	// Dedup: if a tab with the same URL is already open, skip reopening it.
	// State (opened/repeat reschedule) was already persisted above, so dropping
	// from toOpen leaves the item looking like it woke up — silently.
	var dedupe = await getOptions('dedupeOnWake');
	if (dedupe !== 'off') {
		var openTabs = await new Promise(r => chrome.tabs.query({}, r));
		var openUrls = new Set((openTabs || []).map(t => t.url).filter(Boolean));
		toOpen = toOpen.filter(s => {
			if (s.tabs) return true;
			if (!s.url || !openUrls.has(s.url)) return true;
			bgLog(['Dedup: skipping already-open tab', s.id, s.url], ['', 'yellow', '', 'pink'], 'yellow');
			return false;
		});
	}

	// When more than 5 tabs wake up at once, suppress the per-item notifications
	// and show a single summary instead.
	var totalTabCount = toOpen.reduce((n, s) => n + (s.tabs && s.tabs.length ? s.tabs.length : 1), 0);
	var quiet = totalTabCount > 5;

	for (var s of toOpen) s.tabs ? (s.selection ? await openSelection(s, !quiet) : await openWindow(s, !quiet)) : await openTab(s, null, !quiet);

	if (quiet) createNotification(null, `${totalTabCount} tabs woke up!`, 'icons/logo.svg', `Snoozz reopened ${totalTabCount} tabs across ${toOpen.length} snooze${toOpen.length === 1 ? '' : 's'}.`);
}

var contextMenuListenerAdded = false;
async function setUpContextMenus(cachedMenus) {
	var cm = cachedMenus || await getOptions('contextMenu');
	if (!cm || !cm.length) cm = DEFAULT_OPTIONS.contextMenu;
	var choices = await getChoices();
	cm = cm.filter(id => choices[id]);
	try { await chrome.contextMenus.removeAll(); } catch (e) { }
	if (!cm.length) return;
	var contexts = getBrowser() === 'firefox' ? ['link', 'tab'] : ['link'];
	if (cm.length === 1) {
		await chrome.contextMenus.create({
			id: cm[0],
			contexts: contexts,
			title: `Snoozz ${choices[cm[0]].label.toLowerCase()}`,
			...(getBrowser() === 'firefox') ? { icons: { 32: `../icons/${cm[0]}.png` } } : {}
		});
	} else {
		await chrome.contextMenus.create({ id: 'snoozz', contexts: contexts, title: 'Snoozz' });
		for (var o of cm) await chrome.contextMenus.create({
			parentId: 'snoozz',
			id: o,
			contexts: contexts,
			title: choices[o].menuLabel || choices[o].label,
			...(getBrowser() === 'firefox') ? { icons: { 32: `../icons/${o}.png` } } : {}
		});
	}
	if (!contextMenuListenerAdded) {
		chrome.contextMenus.onClicked.addListener(snoozeInBackground);
		if (getBrowser() === 'firefox') chrome.contextMenus.onShown.addListener(contextMenuUpdater);
		contextMenuListenerAdded = true;
	}
}
if (chrome.commands) chrome.commands.onCommand.addListener(async (command, tab) => {
	if (command === 'nap-room') return openExtensionTab('/html/nap-room.html');
	tab = tab || await getTabsInWindow(true);
	await snoozeInBackground({ menuItemId: command, pageUrl: tab.url }, tab)
})

async function snoozeInBackground(item, tab) {
	var c = await getChoices(item.menuItemId);

	var isHref = item.linkUrl && item.linkUrl.length;
	var url = isHref ? item.linkUrl : (item.pageUrl || (tab && tab.url));
	if (!isValid({ url })) return createNotification(null, `Can't snoozz that :(`, 'icons/logo.svg', 'The link you are trying to snooze is invalid.', true);

	var snoozeTime = c && c.time;
	if (!snoozeTime || c.disabled || dayjs().isAfter(dayjs(snoozeTime))) {
		return createNotification(null, `Can't snoozz that :(`, 'icons/logo.svg', 'The time you have selected is invalid.', true);
	}
	// add attributes
	var startUp = c && c.startUp ? true : undefined;
	var targetDevice = c && c._config && c._config.params && c._config.params.device ? c._config.params.device : undefined;
	var title = !isHref ? tab.title : (item.linkText ? item.linkText : item.selectionText);
	var wakeUpTime = snoozeTime.valueOf();
	var pinned = !isHref && tab.pinned ? tab.pinned : undefined;
	var cookieStoreId = tab.cookieStoreId;
	var assembledTab = Object.assign(item, { url, title, pinned, cookieStoreId, startUp, wakeUpTime, targetDevice })

	var snoozed = await snoozeTab(startUp ? 'startup' : snoozeTime.valueOf(), assembledTab, targetDevice);

	var msg = `${!isHref ? tab.title : getHostname(url)} will wake up ${formatSnoozedUntil(assembledTab)}.`
	createNotification(snoozed.tabDBId, 'A new tab is now napping :)', 'icons/logo.svg', msg, true);

	if (!isHref) await chrome.tabs.remove(tab.id);
	await chrome.runtime.sendMessage({ updateDash: true });
}

async function contextMenuUpdater(menu) {
	var choices = await getChoices();
	for (c of menu.menuIds) {
		if (choices[c]) await chrome.contextMenus.update(c, { enabled: !choices[c].disabled });
	}
	await chrome.contextMenus.refresh();
}

async function cleanUpHistory(tabs) {
	var h = await getOptions('history') || 365;
	var tabsToDelete = tabs.filter(t => h && t.opened && dayjs().isAfter(dayjs(t.opened).add(h, 'd')));
	if (tabsToDelete.length === 0) return;
	bgLog(['Deleting old tabs automatically:', tabsToDelete.map(t => t.id)], ['', 'red'], 'red')
	await saveTabs(tabs.filter(t => !tabsToDelete.includes(t)));
}

var _syncHandler = null;
var _firstPullResolve = null;
var firstPull = null;

async function resolveConflictRemoteWins(docId) {
	var doc = await localDB.get(docId, { conflicts: true });
	if (!doc._conflicts || !doc._conflicts.length) return;
	var toDelete = doc._conflicts.map(rev => ({ _id: docId, _rev: rev, _deleted: true }));
	await localDB.bulkDocs(toDelete);
}

var setSyncStatus = s => chrome.storage.local.set({ snoozzSyncStatus: s });

async function setupCouchSync() {
	if (_syncHandler) { _syncHandler.cancel(); _syncHandler = null; }
	var cfg = await getOptions('couchdb');
	if (!cfg || !cfg.url || !cfg.database) { setSyncStatus('inactive'); return; }
	var url = cfg.url.replace(/\/$/, '');
	var proto = url.indexOf('https://') === 0 ? 'https://' : 'http://';
	var host = url.replace(/^https?:\/\//, '');
	var auth = cfg.username ? cfg.username + ':' + encodeURIComponent(cfg.password || '') + '@' : '';
	var remoteUrl = proto + auth + host + '/' + cfg.database;
	var remoteDB = new PouchDB(remoteUrl);
	setSyncStatus('connecting');
	firstPull = new Promise(r => _firstPullResolve = r);
	_syncHandler = PouchDB.sync(localDB, remoteDB, { live: true, retry: true })
		.on('change', async info => {
			if (info.direction !== 'pull') return;
			for (var doc of info.change.docs) {
				try {
					var d = await localDB.get(doc._id, { conflicts: true });
					if (d._conflicts && d._conflicts.length) await resolveConflictRemoteWins(doc._id);
				} catch (e) { }
			}
		})
		.on('active', _ => setSyncStatus('syncing'))
		.on('paused', err => {
			setSyncStatus(err ? 'retrying' : 'connected');
			// First time the live sync catches up (no error) the local DB reflects the server.
			if (!err && _firstPullResolve) { _firstPullResolve(); _firstPullResolve = null; }
		})
		.on('error', e => { setSyncStatus('error'); bgLog(['CouchDB sync error:', e.message || e], ['', 'red'], 'red'); });
	bgLog(['CouchDB sync started:', remoteUrl.replace(/:([^@]+)@/, ':***@')], ['', 'green'], 'green');
}

// Start the CouchDB sync (if configured) and wait for the first pull from the
// server to complete, or until timeoutMs elapses — whichever comes first. This
// lets browser-startup tab opening reflect what other devices already did.
async function waitForInitialSync(timeoutMs = 8000) {
	var cfg = await getOptions('couchdb');
	if (!cfg || !cfg.url || !cfg.database) return;
	await setupCouchSync();
	if (!firstPull) return;
	bgLog(['Waiting for first sync with server before waking startup tabs'], ['yellow'], 'yellow');
	await Promise.race([firstPull, new Promise(r => setTimeout(r, timeoutMs))]);
}

async function setUpExtension() {
	var snoozed = await getSnoozedTabs();
	if (!snoozed || !snoozed.length || snoozed.length === 0) await saveTabs([]);
	var options = await getOptions();
	options = Object.assign(DEFAULT_OPTIONS, options);
	options = upgradeSettings(options);
	await saveOptions(options);
	await ensureDeviceName();
	await setupCouchSync();
	await init();
}
function sendToLogs([which, p1]) {
	try {
		if (['tab', 'window', 'group', 'selection'].includes(which)) bgLog(['Snoozing a new ' + which, p1.id, 'till', dayjs(p1.wakeUpTime).format('HH:mm:ss DD/MM/YY')], ['', 'green', '', 'yellow'], 'green')
		if (which === 'history') bgLog(['Sending tabs to history:', p1.join(', ')], ['', 'green'], 'blue');
		if (which === 'manually') bgLog(['Waking up tabs manually:', p1.join(', ')], ['', 'green'], 'blue');
		if (which === 'delete') bgLog(['Deleting tabs manually:', p1.join(', ')], ['', 'red'], 'red');
	} catch (e) { console.log('logError', e, which, p1) }
}

async function init(isStartup) {
	// On browser startup, give the server sync a chance to pull remote state first
	// so we don't reopen startup tabs another device already handled.
	if (isStartup) await waitForInitialSync();
	var myDevice = await ensureDeviceName();
	await upsertDeviceRegistry(myDevice);
	var allTabs = await getSnoozedTabs();
	var isMyStartupTab = t => (t.startUp || (t.repeat && t.repeat.type === 'startup')) && !t.opened && (!t.targetDevice || t.targetDevice === myDevice);
	if (allTabs && allTabs.length && allTabs.some(isMyStartupTab)) {
		allTabs.filter(isMyStartupTab).forEach(t => t.wakeUpTime = dayjs().subtract(10, 's').valueOf());
		await saveTabs(allTabs);
	}
	await wakeUpTask();
	// Context menus are set up at top-level on every background load (and rebuilt on
	// option changes), so init() must not also call setUpContextMenus — doing both
	// races two removeAll()/create() cycles and can throw a duplicate-id error.
}

chrome.runtime.onInstalled.addListener(async details => {
	setUpExtension();
	if (details && details.reason && details.reason == 'update' && details.previousVersion && details.previousVersion != chrome.runtime.getManifest().version) {
		if (chrome.runtime.getManifest().version.search(/^\d{1,3}(\.\d{1,3}){1,2}$/) !== 0) return;		// skip if minor version
		await new Promise(r => chrome.storage.local.set({ 'updated': true }, r));
		if (chrome.notifications) createNotification(null, 'Snoozz has been updated', 'icons/logo.svg', 'Click here to see what\'s new.', true);
	}
});
chrome.runtime.onStartup.addListener(_ => init(true));
setUpContextMenus();
chrome.alarms.onAlarm.addListener(async a => { if (a.name === 'wakeUpTabs') await wakeUpTask() });
if (chrome.idle) chrome.idle.onStateChanged.addListener(async s => {
	if (s === 'active' || getBrowser() === 'firefox') {
		if (navigator && navigator.onLine === false) {
			window.addEventListener('online', async _ => { await wakeUpTask() }, { once: true });
		} else {
			await wakeUpTask();
		}
	}
});
