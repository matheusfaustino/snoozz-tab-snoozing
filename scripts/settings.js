async function initialize() {
	document.querySelector('.nap-room').addEventListener('keyup', e => {if (e.which === 13) openExtensionTab('/html/nap-room.html')})
	document.querySelector('.nap-room').addEventListener('click', _ => openExtensionTab('/html/nap-room.html'));
	showIconOnScroll();
	fillAbout()

	if (window.location.hash) {
		if (document.getElementById(window.location.hash.slice(1))) highlightSetting(window.location.hash.slice(1))
		window.location.hash = '';
		window.history.replaceState(null, null, window.location.pathname);
	}
	var options = await getOptions();
	options = upgradeSettings(options);
	if (options.icons) document.querySelector('.nap-room img').src = `../icons/${options.icons}/nap-room.png`;

	try {updateFormValues(options)} catch(e) {}
	
	addListeners();
	await fetchHourFormat();

	// calculateStorage();
	// chrome.storage.onChanged.addListener(calculateStorage);

	updateSyncStatus();
	chrome.storage.onChanged.addListener(changes => { if (changes.snoozzSyncStatus) updateSyncStatus(changes.snoozzSyncStatus.newValue); });

	if (localDB && localDB.changes) {
		localDB.changes({live: true, since: 'now', include_docs: false}).on('change', info => {
			if (info && info.id && info.id.indexOf('device:') === 0) {
				var current = document.getElementById('deviceName');
				renderKnownDevices(current ? current.value.trim() : '');
			}
		});
	}
	

	if (getBrowser() === 'safari') chrome.runtime.sendMessage({wakeUp: true});
}
function highlightSetting(name, condition) {
	var el = document.getElementById(name).closest('.input-container');
	if (condition !== undefined) return el.classList.toggle('highlight', condition)
	el.classList.add('highlight');
	setTimeout(_ =>el.scrollIntoView({behavior: 'smooth', block: 'center'}), 1000);
	document.getElementById(name).addEventListener('click', _ => el.classList.remove('highlight'), {once: true})
}

async function calculateStorage() {
	var available = ((chrome.storage.local.QUOTA_BYTES || 5242880) / 1000).toFixed(1);
	var used = (await getStorageSize() / 1000).toFixed(1);
	var sizeAndSuffix = num => num < 1000 ? num + 'KB' : (num/1000).toFixed(2) + 'MB'
	document.querySelector('.storage-used').style.clipPath = `inset(0 ${99 - (used * 100 / available)}% 0 0)`;
	document.querySelector('.storage-text').innerText = `${sizeAndSuffix(used)} of ${sizeAndSuffix(available)} used.`
	document.querySelector('.storage-low').classList.toggle('hidden', used / available < .75 || used / available >= 1);
	document.querySelector('.storage-full').classList.toggle('hidden', used / available < 1);
	highlightSetting('storage', used / available >= 1)
}

function updateFormValues(storage) {
	['morning', 'evening'].forEach(o => {
		if (typeof storage[o] === 'number' || (typeof storage[o] === 'object' && storage[o].length !== 2)) storage[o] = [storage[o], 0];
		document.getElementById(`${o}_h`).value = storage[o][0];
		document.getElementById(`${o}_m`).value = storage[o][1];
	});
	['history', 'icons', 'theme', 'notifications', 'badge', 'closeDelay', 'hourFormat', 'weekStart'].forEach(o => {
		if (storage[o] !== undefined && document.querySelector(`#${o} option[value="${storage[o]}"]`)) {
			document.getElementById(o).value = storage[o].toString();
			document.getElementById(o).setAttribute('data-orig-value', storage[o]);
		}
	});
	var devNameEl = document.getElementById('deviceName');
	if (devNameEl) {
		devNameEl.value = storage.deviceName || '';
		devNameEl.setAttribute('data-orig-value', storage.deviceName || '');
	}
	var choices = (storage.choiceConfig && storage.choiceConfig.length) ? storage.choiceConfig : DEFAULT_CHOICES;
	renderChoiceList(choices);
	renderContextMenu(choices, storage.contextMenu || DEFAULT_OPTIONS.contextMenu);
	if (storage.couchdb) {
		['url', 'username', 'password', 'database'].forEach(k => {
			var el = document.getElementById('couchdb_' + k);
			if (el) el.value = storage.couchdb[k] || '';
		});
	}
	renderKnownDevices(storage.deviceName || '');
	resizeDropdowns();
}

async function renderKnownDevices(myName) {
	var list = document.getElementById('known-devices-list');
	if (!list) return;
	var devices = await getKnownDevices();
	list.innerHTML = '';
	if (!devices.length) {
		var empty = Object.assign(document.createElement('span'), {className: 'device-empty', innerText: 'No devices have registered yet.'});
		list.append(empty);
		return;
	}
	devices.forEach(d => {
		var pill = Object.assign(document.createElement('span'), {className: 'device-pill' + (d.name === myName ? ' self' : ''), innerText: d.name});
		list.append(pill);
	});
}

function renderChoiceList(choices) {
	var list = document.getElementById('choice-list');
	list.innerHTML = '';
	choices.forEach((c, idx) => {
		var row = document.createElement('div');
		row.className = 'choice-item';
		row.setAttribute('data-id', c.id);

		var upBtn = Object.assign(document.createElement('button'), {className: 'choice-move', title: 'Move up', innerText: '▲'});
		upBtn.disabled = idx === 0;
		upBtn.addEventListener('click', _ => moveChoice(c.id, -1));

		var downBtn = Object.assign(document.createElement('button'), {className: 'choice-move', title: 'Move down', innerText: '▼'});
		downBtn.disabled = idx === choices.length - 1;
		downBtn.addEventListener('click', _ => moveChoice(c.id, 1));

		var cb = Object.assign(document.createElement('input'), {type: 'checkbox', id: 'toggle-' + c.id, checked: c.enabled !== false});
		cb.addEventListener('change', _ => toggleChoice(c.id, cb.checked));

		var iconEl;
		if (c.icon) {
			iconEl = Object.assign(document.createElement('span'), {className: 'choice-icon choice-icon-emoji', innerText: c.icon});
		} else if (c.builtin) {
			iconEl = Object.assign(document.createElement('img'), {className: 'choice-icon', src: `../icons/human/${c.id}.png`});
			iconEl.onerror = _ => { iconEl.src = '../icons/unknown.png'; iconEl.onerror = null; };
		} else {
			iconEl = Object.assign(document.createElement('span'), {className: 'choice-icon choice-icon-emoji choice-icon-empty', innerText: '+'});
		}
		if (!c.builtin) {
			iconEl.title = 'Click to set emoji';
			iconEl.style.cursor = 'pointer';
			iconEl.addEventListener('click', _ => editChoiceIcon(c.id));
		}

		var lbl = Object.assign(document.createElement('label'), {htmlFor: 'toggle-' + c.id, innerText: c.label});
		lbl.className = 'choice-label';

		var preview = Object.assign(document.createElement('span'), {className: 'choice-preview', innerText: getChoicePreview(c)});

		row.append(upBtn, downBtn, cb, iconEl, lbl, preview);

		if (!c.builtin) {
			var del = Object.assign(document.createElement('button'), {className: 'choice-delete', title: 'Delete', innerText: '×'});
			del.addEventListener('click', _ => deleteChoice(c.id));
			row.append(del);
		}

		list.append(row);
	});
}

function getChoicePreview(c) {
	var p = c.params || {};
	switch (c.type) {
		case 'startup': return 'On browser launch';
		case 'relative': return `In ${p.amount} ${p.unit}${p.amount > 1 ? 's' : ''}`;
		case 'morning': return `${p.day === 'tomorrow' ? 'Tomorrow' : 'Today'} at morning time`;
		case 'evening': return `${p.day === 'tomorrow' ? 'Tomorrow' : 'Today'} at evening time`;
		case 'fixed': return `${p.day === 'tomorrow' ? 'Tomorrow' : 'Today'} at ${String(p.hour || 0).padStart(2,'0')}:${String(p.minute || 0).padStart(2,'0')}`;
		case 'weekday': return `Next ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][p.weekday] || '?'} at ${p.modifier}`;
		case 'week': return `Next week at ${p.modifier}`;
		case 'month': return 'Next month';
		default: return '';
	}
}

function renderContextMenu(choices, saved) {
	var container = document.getElementById('contextMenu');
	container.innerHTML = '';
	var enabled = choices.filter(c => c.enabled !== false);
	enabled.forEach(c => {
		var hasModifier = c.params && c.params.modifier !== undefined;
		var row = document.createElement('div');
		var cb = Object.assign(document.createElement('input'), {type: 'checkbox', id: 'ctx-' + c.id, checked: saved.includes(c.id)});
		cb.addEventListener('change', saveContextMenu);
		var lbl = document.createElement('label');
		lbl.htmlFor = 'ctx-' + c.id;
		var span = Object.assign(document.createElement('span'), {innerText: c.label});
		lbl.append(span);
		if (hasModifier) {
			var sw = document.createElement('div');
			sw.className = 'select-wrapper';
			var sel = document.createElement('select');
			sel.className = 'popup';
			sel.id = 'popup_' + c.id;
			['morning', 'evening', 'now'].forEach(v => {
				var opt = Object.assign(document.createElement('option'), {value: v, innerText: v === 'now' ? 'Current Time' : v.charAt(0).toUpperCase() + v.slice(1), selected: (c.params.modifier || 'morning') === v});
				sel.append(opt);
			});
			sel.addEventListener('change', async e => {
				await saveChoiceModifier(c.id, e.target.value);
				var choices2 = await getOptions('choiceConfig') || DEFAULT_CHOICES;
				var found = choices2.find(x => x.id === c.id);
				if (found) found.params.modifier = e.target.value;
				renderChoiceList(choices2);
			});
			sw.append(sel);
			lbl.append(sw);
		}
		row.append(cb, lbl);
		container.append(row);
	});
}

async function saveContextMenu() {
	var checked = Array.from(document.querySelectorAll('#contextMenu input:checked')).map(c => c.id.replace('ctx-', ''));
	if (checked.length > 5) {
		var last = document.querySelector('#contextMenu input:checked:last-of-type');
		if (last) { last.checked = false; return; }
	}
	var o = await getOptions();
	if (!o || Array.isArray(o)) o = {};
	o.contextMenu = checked;
	await saveOptions(o);
}

async function getCurrentChoices() {
	var o = await getOptions();
	if (!o || Array.isArray(o)) o = {};
	return (o.choiceConfig && o.choiceConfig.length) ? o.choiceConfig : DEFAULT_CHOICES.map(c => Object.assign({}, c, {params: Object.assign({}, c.params)}));
}

async function toggleChoice(id, enabled) {
	var choices = await getCurrentChoices();
	var c = choices.find(x => x.id === id);
	if (c) c.enabled = enabled;
	await saveOption('choiceConfig', choices);
	renderChoiceList(choices);
	var saved = (await getOptions('contextMenu')) || DEFAULT_OPTIONS.contextMenu;
	renderContextMenu(choices, saved);
}

async function moveChoice(id, dir) {
	var choices = await getCurrentChoices();
	var idx = choices.findIndex(c => c.id === id);
	if (idx < 0) return;
	var newIdx = idx + dir;
	if (newIdx < 0 || newIdx >= choices.length) return;
	choices.splice(newIdx, 0, choices.splice(idx, 1)[0]);
	await saveOption('choiceConfig', choices);
	renderChoiceList(choices);
}

async function deleteChoice(id) {
	var choices = await getCurrentChoices();
	choices = choices.filter(c => c.id !== id);
	var saved = (await getOptions('contextMenu')) || DEFAULT_OPTIONS.contextMenu;
	saved = saved.filter(x => x !== id);
	var o = await getOptions();
	if (!o || Array.isArray(o)) o = {};
	o.choiceConfig = choices;
	o.contextMenu = saved;
	await saveOptions(o);
	renderChoiceList(choices);
	renderContextMenu(choices, saved);
}

async function addChoice() {
	var label = document.getElementById('new-choice-label').value.trim();
	if (!label) { document.getElementById('new-choice-label').focus(); return; }
	var icon = document.getElementById('new-choice-icon').value.trim();
	var type = document.getElementById('new-choice-type').value;
	var id = 'custom-' + Date.now();
	var params = {};

	if (type === 'fixed-today' || type === 'fixed-tomorrow') {
		params = {
			day: type === 'fixed-tomorrow' ? 'tomorrow' : 'today',
			hour: parseInt(document.getElementById('new-fixed-hour').value) || 0,
			minute: parseInt(document.getElementById('new-fixed-minute').value) || 0,
		};
		type = 'fixed';
	} else if (type === 'relative') {
		params = {
			amount: parseInt(document.getElementById('new-rel-amount').value) || 1,
			unit: document.getElementById('new-rel-unit').value,
		};
	} else if (type === 'morning-today') { params = {day: 'today'}; type = 'morning'; }
	else if (type === 'morning-tomorrow') { params = {day: 'tomorrow'}; type = 'morning'; }
	else if (type === 'evening-today') { params = {day: 'today'}; type = 'evening'; }
	else if (type === 'evening-tomorrow') { params = {day: 'tomorrow'}; type = 'evening'; }
	else if (type === 'weekday') {
		params = {
			weekday: parseInt(document.getElementById('new-weekday').value),
			modifier: document.getElementById('new-weekday-modifier').value,
		};
	}

	var repeatId = null;
	if (type === 'relative' && params.unit === 'hour' && params.amount === 1) repeatId = 'hourly';

	var newChoice = {id, label, type, params, enabled: true, builtin: false, repeat_id: repeatId, menuLabel: label.toLowerCase(), icon: icon || null};
	var choices = await getCurrentChoices();
	choices.push(newChoice);
	await saveOption('choiceConfig', choices);
	renderChoiceList(choices);
	var saved = (await getOptions('contextMenu')) || DEFAULT_OPTIONS.contextMenu;
	renderContextMenu(choices, saved);
	document.getElementById('add-choice-form').classList.add('hidden');
	document.getElementById('new-choice-label').value = '';
	document.getElementById('new-choice-icon').value = '';
}

async function editChoiceIcon(id) {
	var current = await getCurrentChoices();
	var c = current.find(x => x.id === id);
	if (!c) return;
	var emoji = prompt('Set an emoji for this choice (leave empty to remove):', c.icon || '');
	if (emoji === null) return;
	c.icon = emoji.trim() || null;
	await saveOption('choiceConfig', current);
	renderChoiceList(current);
}

function addListeners() {
	document.querySelectorAll('select.direct').forEach(s => s.addEventListener('change', save));
	document.querySelectorAll('.couchdb-input').forEach(i => i.addEventListener('change', save));
	var devNameEl = document.getElementById('deviceName');
	if (devNameEl) devNameEl.addEventListener('change', save);

	var addBtn = document.getElementById('add-choice-btn');
	addBtn.addEventListener('click', _ => document.getElementById('add-choice-form').classList.toggle('hidden'));
	addBtn.onkeyup = e => {if (e.which === 13) document.getElementById('add-choice-form').classList.toggle('hidden');}

	document.getElementById('new-choice-type').addEventListener('change', updateAddChoiceParams);

	document.getElementById('save-new-choice').addEventListener('click', addChoice);
	document.getElementById('save-new-choice').onkeyup = e => {if (e.which === 13) addChoice();}


	document.querySelector('#shortcut .btn').addEventListener('click', toggleShortcuts);
	document.querySelector('#shortcut .btn').onkeyup = e => {if (e.which === 13) toggleShortcuts()}

	document.querySelector('#right-click .btn').addEventListener('click', toggleRightClickOptions);
	document.querySelector('#right-click .btn').onkeyup = e => {if (e.which === 13) toggleRightClickOptions()}

	document.addEventListener('visibilitychange', updateKeyBindings);

	document.querySelectorAll('a[data-highlight="history"]').forEach(a => a.addEventListener('click', e => highlightSetting('history')))

	document.getElementById('import').addEventListener('click', _ => document.getElementById('import_hidden').click());
	document.getElementById('import').onkeyup = e => {if (e.which === 13) document.getElementById('import_hidden').click()}
	document.getElementById('import_hidden').addEventListener('change', importTabs);

	document.getElementById('export').addEventListener('click', exportTabs);
	document.getElementById('export').onkeyup = e => {if (e.which === 13) exportTabs()}

	document.getElementById('reset').addEventListener('click', resetSettings);
	document.getElementById('reset').onkeyup = e => {if (e.which === 13) resetSettings()}

	document.querySelector('code').addEventListener('click', _ => {
		clipboard('about:addons')
		document.querySelector('body > .copied').classList.add('toast');
		setTimeout(_ => document.querySelector('body > .copied').classList.remove('toast'), 4000)
	});
}

async function save(e) {
	e.stopPropagation();
	if (e && e.target.id === 'history') {
		var tabs = await getSnoozedTabs();
		var count = tabs.filter(t => t.opened && dayjs().isAfter(dayjs(t.opened).add(e.target.value, 'd'))).length;
		if (count > 0 && !window.confirm(`Changing this setting will remove ${count} tab${count > 1 ? 's' : ''} from your Snoozz history. Are you sure you want to continue with this change?`)) {
			return e.target.value = e.target.getAttribute('data-orig-value');
		}
	}

	var options = await getOptions();
	if (!options || Array.isArray(options)) options = {};
	if (e && ['morning', 'evening'].includes(e.target.id)) {
		var tabs = await getSnoozedTabs();
		var ot = parseInt(e.target.getAttribute('data-orig-value'));
		var f = t => !t.opened && dayjs(t.wakeUpTime).hour() === ot && dayjs(t.wakeUpTime).minute() === 0 && dayjs(t.wakeUpTime).second() === 0;
		var tabsToChange = tabs.filter(f);
		if (tabsToChange.length) {
			var count = `${tabsToChange.length > 1 ? 'are' : 'is'} ${tabsToChange.length} tab${tabsToChange.length > 1 ? 's' : ''}`;
			if (confirm(`There ${count} scheduled to wake up at ${dayjs().minute(0).hour(ot).format(getHourFormat())}.
Would you like to update ${tabsToChange.length > 1 ? 'them' : 'it'} to snooze till ${dayjs().minute(0).hour(e.target.value).format(getHourFormat())}?`)) {
				tabs.filter(f).forEach(t => {
					t.modifiedTime = dayjs().valueOf();
					t.wakeUpTime = dayjs(t.wakeUpTime).hour(e.target.value).valueOf();
				});
				await saveTabs(tabs);
			}
		}
	}
	document.querySelectorAll('select.direct').forEach(s => options[s.id] = isNaN(s.value) ? s.value : parseInt(s.value));
	['morning', 'evening'].forEach(o => options[o] = [parseInt(document.getElementById(`${o}_h`).value), parseInt(document.getElementById(`${o}_m`).value)]);
	options.couchdb = options.couchdb || {};
	['url', 'username', 'password', 'database'].forEach(k => {
		var el = document.getElementById('couchdb_' + k);
		if (el) options.couchdb[k] = el.value.trim();
	});

	var devNameEl = document.getElementById('deviceName');
	var oldDeviceName = '';
	var newDeviceName = '';
	if (devNameEl) {
		oldDeviceName = (devNameEl.getAttribute('data-orig-value') || '').trim();
		newDeviceName = devNameEl.value.trim();
		if (!newDeviceName) {
			newDeviceName = 'device-' + getRandomId().substring(0, 6).toLowerCase();
			devNameEl.value = newDeviceName;
		}
		options.deviceName = newDeviceName;
	}

	await saveOptions(options);

	if (devNameEl && oldDeviceName && oldDeviceName !== newDeviceName) {
		await renameDeviceOnTabs(oldDeviceName, newDeviceName);
		await removeDeviceRegistry(oldDeviceName);
	}
	if (devNameEl && newDeviceName) {
		await upsertDeviceRegistry(newDeviceName);
		devNameEl.setAttribute('data-orig-value', newDeviceName);
		await renderKnownDevices(newDeviceName);
	}

	await setTheme();
	await fetchHourFormat();
	await changeIcons(options.icons);
	if (e && e.target.tagName.toLowerCase() === 'select') e.target.setAttribute('data-orig-value', e.target.value);
}

function toggleRightClickOptions(e) {
	
	var collapsed = document.getElementById('contextMenu');
	var s = collapsed.closest('.input-container');
	s.classList.toggle('show');
	collapsed.style.maxHeight = s.classList.contains('show') ? `calc(${collapsed.scrollHeight}px + 1em)` : '0px'
}

function updateAddChoiceParams() {
	var type = document.getElementById('new-choice-type').value;
	document.getElementById('params-fixed').classList.toggle('hidden', !type.startsWith('fixed'));
	document.getElementById('params-relative').classList.toggle('hidden', type !== 'relative');
	document.getElementById('params-weekday').classList.toggle('hidden', type !== 'weekday');
}

function toggleShortcuts(e) {
	var s =  document.getElementById('shortcut').closest('.input-container');
	s.classList.toggle('show');
	s.querySelectorAll('.mini').forEach(el => {
		el.style.maxHeight = '0';
		el.style.visibility= 'hidden';
	});
	updateKeyBindings();

	var browserInfo = s.querySelector(`.${getBrowser()}-info`);
	browserInfo.querySelectorAll('a[data-href]').forEach(s => {
		s.onclick = e => chrome.tabs.create({url: e.target.getAttribute('data-href'), active: true});
		s.onkeyUp = e => { if (e.which === 13) chrome.tabs.create({url: e.target.getAttribute('data-href'), active: true})}
	});
	if (s.classList.contains('show')) {
		browserInfo.style.maxHeight = browserInfo.scrollHeight + 'px';
		browserInfo.style.visibility = 'visible';
	}
	document.querySelector('.mini.shortcuts').style.visibility = 'visible';

}

async function updateKeyBindings() {
	var commands = await getKeyBindings();
	commands = commands.filter(c => c.shortcut && c.shortcut !== '');
	if (commands.length === 0) return document.querySelector('.shortcuts').style.maxHeight = '0px';
	var choices = await getChoices();

	var bindings = document.querySelector('.bindings');
	bindings.innerText = '';

	var splitShortcut = s => s.split(s.indexOf('+') > -1 ? '+' : '');

	commands.forEach(c => {
		var keys = wrapInDiv('', ...splitShortcut(c.shortcut).map(s => Object.assign(document.createElement('kbd'),{innerText: s})));
		if (choices[c.name]) bindings.append(wrapInDiv('flex', wrapInDiv({innerText: choices[c.name].label}), keys));
		if (c.name === 'nap-room') bindings.append(wrapInDiv('flex', wrapInDiv({innerText: 'Open Sleeping Tabs'}), keys));
		if (c.name === '_execute_browser_action') bindings.append(wrapInDiv('flex', wrapInDiv({innerText: 'Open Popup'}), keys));
	});
	if (document.getElementById('shortcut').classList.contains('show')) {
		document.querySelector('.shortcuts').style.maxHeight = document.querySelector('.shortcuts').scrollHeight + 'px';	
	} 
}

async function resetSettings() {
	if (!confirm('Are you sure you want to reset all settings? \nYou can\'t undo this.')) return;

	await saveOptions(DEFAULT_OPTIONS);
	updateFormValues(DEFAULT_OPTIONS);
	await setTheme();
}

async function changeIcons(name) {
	if (!name) name = await getOptions('icons');
	if (!name || !name.length) name = 'human';
	document.querySelector('.nap-room img').src = `../icons/${name}/nap-room.png`;
}

async function exportTabs() {
	var tabs = (await getSnoozedTabs()).map(t => {var c = Object.assign({}, t); delete c._id; delete c._rev; return c;});
	var choices = await getCurrentChoices();
	var payload = {version: 1, exportedAt: dayjs().toISOString(), tabs, choices};
	var now = dayjs();
	var element = document.createElement('a');
	element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload)));
	element.setAttribute('download', `Snoozz_export_${now.format('YYYY')}_${now.format('MM')}_${now.format('DD')}.txt`);
	element.style.display = 'none';
	document.body.appendChild(element);
	element.click();
	document.body.removeChild(element);
}

async function importTabs(e) {
	try {
		var text = await e.target.files[0].text();
		var parsed = JSON.parse(text);

		var json_array, importedChoices = null;
		if (Array.isArray(parsed)) {
			json_array = parsed;
		} else if (parsed && typeof parsed === 'object') {
			json_array = Array.isArray(parsed.tabs) ? parsed.tabs : [];
			if (Array.isArray(parsed.choices) && parsed.choices.length) importedChoices = parsed.choices;
		} else {
			throw false;
		}

		var choiceCount = 0;
		if (importedChoices) {
			var current = await getCurrentChoices();
			var byId = {};
			current.forEach(c => { byId[c.id] = c; });
			importedChoices.forEach(c => {
				if (!c || !c.id || !c.type) return;
				if (byId[c.id]) Object.assign(byId[c.id], c);
				else { current.push(c); byId[c.id] = c; choiceCount++; }
			});
			await saveOption('choiceConfig', current);
			var savedCtx = (await getOptions('contextMenu')) || DEFAULT_OPTIONS.contextMenu;
			renderChoiceList(current);
			renderContextMenu(current, savedCtx);
		}

		var tabCount = 0;
		if (json_array && json_array.length) {
			var allTabs = await getSnoozedTabs();
			var existing_ids = allTabs.map(at => at.id), needs_update = [];
			json_array = json_array.filter(t => {
				if (!verifyTab(t)) return false;
				if (!existing_ids.includes(t.id)) return true;
				var existing = allTabs.find(at => at.id === t.id);
				if (!existing.opened && (t.opened || (t.modifiedTime && !existing.modifiedTime) || (existing.modifiedTime && t.modifiedTime && dayjs(t.modifiedTime) > dayjs(existing.modifiedTime)))) {
					needs_update.push(existing.id);
					return true;
				}
				return false;
			});
			await saveTabs(allTabs.filter(at => !needs_update.includes(at.id)).concat(json_array));
			tabCount = json_array.length;
		}

		if (!tabCount && !choiceCount && !importedChoices) throw false;

		var parts = [];
		if (tabCount) parts.push(`${tabCount} tab${tabCount === 1 ? '' : 's'}`);
		if (importedChoices) parts.push(`${importedChoices.length} choice${importedChoices.length === 1 ? '' : 's'}`);
		document.querySelector('body > .import-success').innerText = `Imported ${parts.join(' and ')} from ${e.target.files[0].name}`;
		document.querySelector('body > .import-success').classList.add('toast');
		setTimeout(_ => document.querySelector('body > .import-success').classList.remove('toast'), 4000);
	} catch {
		document.querySelector('body > .import-fail').classList.add('toast');
		setTimeout(_ => document.querySelector('body > .import-fail').classList.remove('toast'), 4000);
	}
}

var SYNC_STATUS_LABELS = {
	inactive:   'not configured',
	connecting: 'connecting...',
	syncing:    'syncing',
	connected:  'connected',
	retrying:   'reconnecting...',
	error:      'connection error'
};

async function updateSyncStatus(status) {
	if (!status) {
		var p = await new Promise(r => chrome.storage.local.get('snoozzSyncStatus', r));
		status = p.snoozzSyncStatus || 'inactive';
	}
	var el = document.getElementById('couchdb-sync-status');
	if (!el) return;
	el.textContent = SYNC_STATUS_LABELS[status] || status;
	el.className = 'sync-status sync-status--' + status;
}

function fillAbout() {
	var versionEl = document.getElementById('version');
	if (versionEl) versionEl.innerText = `Snoozz v${chrome.runtime.getManifest().version}`;
}

window.onload = initialize