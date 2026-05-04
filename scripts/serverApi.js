// Server availability flag — starts false, set true by a successful heartbeat.
// All non-heartbeat calls are skipped while false (circuit-breaker).
var serverAvailable = false;

async function _getServerConfig() {
	var opts = await getOptions(['serverUrl', 'serverToken']);
	return {
		url: (opts.serverUrl || '').trim().replace(/\/$/, ''),
		token: (opts.serverToken || '').trim()
	};
}

function _serverHeaders(token) {
	var h = {'Content-Type': 'application/json'};
	if (token) h['Authorization'] = `Bearer ${token}`;
	return h;
}

async function _serverRequest(method, path, body) {
	var {url, token} = await _getServerConfig();
	if (!url || !serverAvailable) return null;
	try {
		var opts = {method, headers: _serverHeaders(token)};
		if (body !== undefined) opts.body = JSON.stringify(body);
		var res = await Promise.race([
			fetch(`${url}${path}`, opts),
			new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
		]);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res;
	} catch(e) {
		serverAvailable = false;
		return null;
	}
}

// Heartbeat bypasses the circuit-breaker so it can restore availability.
async function serverHeartbeat() {
	var {url, token} = await _getServerConfig();
	if (!url) return false;
	try {
		var res = await Promise.race([
			fetch(`${url}/api/heartbeat`, {
				method: 'POST',
				headers: _serverHeaders(token),
				body: JSON.stringify({timestamp: new Date().toISOString()})
			}),
			new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
		]);
		serverAvailable = res.ok;
		return serverAvailable;
	} catch(e) {
		serverAvailable = false;
		return false;
	}
}

async function serverRegisterSnooze(snooze) {
	var {url, token} = await _getServerConfig();
	if (!url || !serverAvailable) return null;
	try {
		var res = await Promise.race([
			fetch(`${url}/api/snooze`, {method: 'POST', headers: _serverHeaders(token), body: JSON.stringify(snooze)}),
			new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
		]);
		if (res.status === 409) return null;
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.json().catch(() => null);
	} catch(e) {
		serverAvailable = false;
		return null;
	}
}

async function serverGetSnooze(id) {
	var {url, token} = await _getServerConfig();
	if (!url || !serverAvailable) return null;
	try {
		var res = await Promise.race([
			fetch(`${url}/api/snooze/${id}`, {method: 'GET', headers: _serverHeaders(token)}),
			new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
		]);
		if (!res.ok) return null;
		return res.json().catch(() => null);
	} catch(e) {
		return null;
	}
}

async function serverUpdateSnooze(id, data) {
	var res = await _serverRequest('PATCH', `/api/snooze/${id}`, data);
	return res ? res.json().catch(() => null) : null;
}

async function serverGetAllSnoozes() {
	var res = await _serverRequest('GET', '/api/snoozes');
	return res ? res.json().catch(() => []) : [];
}

var isServerAvailable = () => serverAvailable;
