'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require rpc';

/* SPDX-License-Identifier: GPL-3.0-or-later */

var callStart    = rpc.declare({ object: 'luci.lwo', method: 'start',    params: [] });
var callStop     = rpc.declare({ object: 'luci.lwo', method: 'stop',     params: [] });
var callRestart  = rpc.declare({ object: 'luci.lwo', method: 'restart',  params: [] });
var callNext     = rpc.declare({ object: 'luci.lwo', method: 'next',     params: [] });
var callFailover = rpc.declare({ object: 'luci.lwo', method: 'failover', params: [] });
var callSwitch   = rpc.declare({ object: 'luci.lwo', method: 'switch',   params: [ 'ip' ] });
var callUpdate   = rpc.declare({ object: 'luci.lwo', method: 'update',   params: [ 'country' ] });
var callCountries = rpc.declare({ object: 'luci.lwo', method: 'countries', expect: { countries: [] } });

// Region codes understood by `lwo-switch update`, in display order.
var REGIONS = [
	[ 'europe', _('Europe') ],
	[ 'north-america', _('North America') ],
	[ 'south-america', _('South America') ],
	[ 'asia', _('Asia') ],
	[ 'oceania', _('Oceania') ],
	[ 'middle-east', _('Middle East') ],
	[ 'africa', _('Africa') ],
	[ 'other', _('Other') ]
];

function btn(label, cls, fn) {
	return E('button', {
		'class': 'btn cbi-button ' + cls,
		'click': ui.createHandlerFn(this, function() {
			return Promise.resolve(fn()).then(function() {
				ui.addNotification(null,
					E('p', _('Command sent — give it a few seconds, then check the Status tab.')),
					'info');
			});
		})
	}, label);
}

// Extract the endpoint IP (first token) of each configured relay entry.
function peerIPs() {
	return (uci.get('lwo', 'main', 'peer') || []).map(function(e) {
		return String(e).trim().split(/\s+/)[0];
	}).filter(Boolean);
}

// Parse a relay file: one "IP KEY [PORT]" per line; blank lines and #comments ignored.
function parseRelays(text) {
	var ok = [], bad = [];
	text.split(/\r?\n/).forEach(function(raw, i) {
		var line = raw.replace(/#.*/, '').trim();
		if (!line) return;
		var f = line.split(/\s+/);
		var ipOk = /^\d{1,3}(\.\d{1,3}){3}$/.test(f[0]) &&
			f[0].split('.').every(function(o) { return +o <= 255; });
		var portOk = f.length < 3 || (/^\d{1,5}$/.test(f[2]) && +f[2] >= 1 && +f[2] <= 65535);
		if (f.length <= 3 && ipOk && /^[A-Za-z0-9+\/]{43}=$/.test(f[1] || '') && portOk)
			ok.push(f.join(' '));
		else
			bad.push(i + 1);
	});
	return { ok: ok, bad: bad };
}

// Imported entries replace existing ones with the same IP (in place); new IPs are appended.
function mergeRelays(cur, add) {
	var ip = function(e) { return String(e).trim().split(/\s+/)[0]; };
	var byIp = {};
	add.forEach(function(e) { byIp[ip(e)] = e; });
	var out = cur.map(function(e) {
		var n = byIp[ip(e)];
		delete byIp[ip(e)];
		return n || e;
	});
	return out.concat(Object.keys(byIp).map(function(k) { return byIp[k]; }));
}

function importRelays() {
	var file = document.getElementById('lwo-import-file').files[0];
	if (!file)
		return ui.addNotification(null, E('p', _('Choose a text file first.')), 'warning');

	return file.text().then(function(text) {
		var r = parseRelays(text);
		if (!r.ok.length)
			return ui.addNotification(null, E('p', _('No valid relay lines found in the file.')), 'danger');

		var replace = document.getElementById('lwo-import-replace').checked;
		var cur = replace ? [] : [].concat(uci.get('lwo', 'main', 'peer') || []);
		uci.set('lwo', 'main', 'peer', mergeRelays(cur, r.ok));

		var msg = _('Imported %d relay(s).').format(r.ok.length);
		if (r.bad.length)
			msg += ' ' + _('Skipped invalid line(s): %s.').format(r.bad.join(', '));
		return uci.save().then(function() {
			// Reload so the form shows the staged list; Save & Apply then activates it.
			ui.showModal(_('Relays imported'), [
				E('p', msg + ' ' + _('Press Save & Apply to activate.')),
				E('div', { 'class': 'right' }, E('button', {
					'class': 'btn cbi-button-action',
					'click': function() { window.location.reload(); }
				}, _('OK')))
			]);
		});
	});
}

return view.extend({
	load: function() {
		return Promise.all([ uci.load('lwo'), L.resolveDefault(callCountries(), []) ]);
	},

	render: function(data) {
		var countries = data[1] || [], countryOpt;
		var m, s, o;

		m = new form.Map('lwo', _('Mullvad LWO'),
			_('Lightweight WireGuard Obfuscation. LWO only replaces the transport under ' +
			  'an existing WireGuard interface; routing and Policy Based Routing are ' +
			  'unaffected.'));

		s = m.section(form.NamedSection, 'main', 'lwo', _('Settings'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Enable LWO'));
		o.rmempty = false;

		o = s.option(form.Value, 'interface', _('WireGuard interface'),
			_('Existing kernel WireGuard interface to obfuscate.'));
		o.placeholder = 'wg_mullvad';
		o.rmempty = false;

		o = s.option(form.Value, 'listen_port', _('Local listen port'),
			_('Loopback port the WireGuard peer endpoint points at (e.g. 51820).'));
		o.datatype = 'port';
		o.placeholder = '51820';

		o = s.option(form.Value, 'server_port', _('Relay LWO port'),
			_('UDP port for the relay. Any Mullvad WireGuard port works with LWO (e.g. 51820). ' +
			  'Used as the default when a relay entry omits its port.'));
		o.datatype = 'port';

		o = s.option(form.Value, 'client_pubkey', _('Client public key'),
			_("This interface's WireGuard public key (deobfuscates inbound): " +
			  '<code>wg show &lt;iface&gt; public-key</code>'));
		o.rmempty = false;

		o = s.option(form.Value, 'fwmark', _('fwmark'),
			_('Mark on the outbound socket so its packets bypass the tunnel.'));
		o.placeholder = '0x51820';

		o = s.option(form.Flag, 'auto_reconnect', _('Auto reconnect'));

		o = s.option(form.Value, 'reconnect_delay', _('Reconnect delay (s)'));
		o.datatype = 'uinteger';
		o.placeholder = '3';
		o.depends('auto_reconnect', '1');

		o = s.option(form.ListValue, 'log_level', _('Log level'));
		['error', 'warn', 'info', 'debug', 'trace'].forEach(function(v) { o.value(v, v); });
		o.default = 'info';

		// The relay pool — one row per relay: "IP KEY [PORT]".
		o = s.option(form.Value, 'country', _('Country or region'),
			_('Relays of this country, region or of all countries are fetched from the Mullvad API by ' +
			  '<em>Update relay list</em> below. A region tests the relays with the best ping across ' +
			  'its countries, so it usually finds faster relays than one country. Only countries ' +
			  'with LWO relays are listed.'));
		o.value('all', _('All countries (fastest anywhere)'));
		REGIONS.forEach(function(r) {
			var list = countries.filter(function(c) { return (c.region || 'other') === r[0]; });
			if (!list.length) return;
			o.value(r[0], _('%s: all countries').format(r[1]));
			list.forEach(function(c) {
				o.value(c.code, '%s / %s (%s)'.format(r[1], c.name, c.code));
			});
		});
		o.placeholder = 'nl';
		countryOpt = o;

		o = s.option(form.Flag, 'fallback_any', _('Fall back to any country'),
			_('If no relay of the chosen country or region works (or passes the access check), ' +
			  'use the fastest working relay anywhere. The choice above is kept, so the next ' +
			  'update tries it first again. With auto failover on, an update also runs when every ' +
			  'listed relay is down (at most every 15 minutes).'));

		o = s.option(form.Flag, 'access_check', _('Access check'),
			_('After a relay connects, send real traffic through it: data must pass, and the sites ' +
			  'below (if any) must not answer 403, 429, nothing, or a "blocked" / "not available ' +
			  'in your country" page. A Cloudflare browser check is not counted as a block. Relays ' +
			  'that fail are dropped. Needs <code>curl</code>. With <em>Pause internet</em> the ' +
			  'internet stays down while a relay is checked: up to about 17 s for a relay that ' +
			  'passes no data, plus up to 8 s per site.'));

		o = s.option(form.DynamicList, 'access_url', _('Access check sites'),
			_('Optional. Empty: only check that data passes. Sites such as Google search often ' +
			  'answer VPN exits with 429 or "unusual traffic", which drops relays that work fine.'));
		o.placeholder = 'https://claude.ai/login';
		o.depends('access_check', '1');

		o = s.option(form.ListValue, 'probe_mode', _('Relay test mode'),
			_('How <em>Update relay list</em> tests relays. <strong>Pause internet</strong> uses this ' +
			  'device: the tunnel moves to each relay for a few seconds (traffic is dropped, never ' +
			  'leaked), then reconnects. <strong>Second device</strong> keeps the internet up but needs ' +
			  'an extra Mullvad device key.'));
		o.value('switch', _('Pause internet (this device)'));
		o.value('device', _('Second device (internet stays up)'));
		o.default = 'switch';

		o = s.option(form.Value, 'probe_private_key', _('Probe private key'),
			_('Private key of a <strong>second</strong> Mullvad device, used only to test which relays ' +
			  'are reachable without touching the main tunnel. Create it with <code>wg genkey</code> ' +
			  'and add its public key (<code>wg pubkey</code>) to your Mullvad account as a new device.'));
		o.password = true;
		o.depends('probe_mode', 'device');

		o = s.option(form.Value, 'probe_address', _('Probe tunnel address'),
			_('The <code>Address</code> of that second device in its Mullvad WireGuard config ' +
			  '(e.g. <code>10.66.12.34</code>). Needed only for the access check. Mullvad may ' +
			  'give that device a different exit IP than your main one on the same relay, so a ' +
			  'site can block one and not the other: the check is only exact in ' +
			  '<em>Pause internet</em> mode.'));
		o.datatype = 'ip4addr';
		o.depends({ probe_mode: 'device', access_check: '1' });

		o = s.option(form.DynamicList, 'peer', _('Relays'),
			_('Candidate Mullvad relays, one per row: ' +
			  '<code>ENDPOINT_IP PUBLIC_KEY [PORT]</code>. PORT is optional and defaults to ' +
			  'the relay LWO port above. Get IP + key from ' +
			  '<code>api.mullvad.net/app/v1/relays</code>.'));
		o.rmempty = true;

		o = s.option(form.Value, 'active', _('Active relay (IP)'),
			_('Set automatically when you switch relays below.'));
		o.readonly = true;

		o = s.option(form.Flag, 'failover', _('Auto failover'),
			_('If the tunnel goes down, automatically switch to the next working ' +
			  'relay in the list (in order) until one connects.'));

		o = s.option(form.Value, 'failover_interval', _('Failover check interval (s)'),
			_('How often the watcher checks the tunnel health.'));
		o.datatype = 'uinteger';
		o.placeholder = '120';
		o.depends('failover', '1');

		return m.render().then(L.bind(function(mapEl) {
			var ips = peerIPs();
			var sel = E('select', { 'class': 'cbi-input-select', 'id': 'lwo-relay-sel' },
				ips.map(function(ip) { return E('option', { 'value': ip }, ip); }));
			if (!ips.length)
				sel.appendChild(E('option', { 'value': '' }, _('(no relays configured)')));

			var relayCtl = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Relay switching')),
				E('p', {}, _('Save & Apply any changes to the relay list first, then switch. ' +
				  '<em>Update relay list</em> downloads the selected country\'s LWO relays, tests each one ' +
				  'from this router (a few seconds per relay, using the test mode above), keeps only ' +
				  'the ones that connect, ranks them by packet loss and latency (~15 s) and switches to ' +
				  'the best. The list is saved best-first, so failover and Next follow that order. ' +
				  'Save & Apply the test mode first.')),
				E('div', { 'class': 'cbi-value' }, [
					sel, ' ',
					btn.call(this, _('Switch to selected'), 'cbi-button-apply', function() {
						var ip = document.getElementById('lwo-relay-sel').value;
						return ip ? callSwitch(ip) : Promise.resolve();
					}),
					' ',
					btn.call(this, _('Next relay'), 'cbi-button-neutral', function() { return callNext(); }),
					' ',
					btn.call(this, _('Failover now'), 'cbi-button-neutral', function() { return callFailover(); }),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': ui.createHandlerFn(this, function() {
							return callUpdate(countryOpt.formvalue('main') || '').then(function() {
								ui.addNotification(null, E('p', _('Updating the relay list in the background. ' +
									'Follow progress in the Logs tab, then reload this page.')), 'info');
							});
						})
					}, _('Update relay list'))
				])
			]);

			var importCtl = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Import relays from file')),
				E('p', {}, _('A plain text file with one relay per line, same format as the list above: ' +
				  '<code>ENDPOINT_IP PUBLIC_KEY [PORT]</code>. Blank lines and <code>#</code> comments ' +
				  'are ignored. Relays with an IP already in the list are updated.')),
				E('div', { 'class': 'cbi-value' }, [
					E('input', { 'type': 'file', 'id': 'lwo-import-file', 'accept': '.txt,.conf,.list,text/plain' }),
					' ',
					E('label', {}, [ E('input', { 'type': 'checkbox', 'id': 'lwo-import-replace' }),
						' ', _('Replace the whole list') ]),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-add',
						'click': ui.createHandlerFn(this, importRelays)
					}, _('Import'))
				])
			]);

			var svcCtl = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Service control')),
				E('div', { 'class': 'cbi-value' }, [
					btn.call(this, _('Connect'), 'cbi-button-apply', function() { return callStart(); }), ' ',
					btn.call(this, _('Disconnect'), 'cbi-button-reset', function() { return callStop(); }), ' ',
					btn.call(this, _('Restart'), 'cbi-button-neutral', function() { return callRestart(); })
				])
			]);

			return E([], [ mapEl, importCtl, relayCtl, svcCtl ]);
		}, this));
	}
});
