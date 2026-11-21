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
		var port = f.length === 3 ? +f[2] : 1;
		if (f.length <= 3 && /^\d{1,3}(\.\d{1,3}){3}$/.test(f[0]) &&
		    /^[A-Za-z0-9+\/]{43}=$/.test(f[1] || '') && port >= 1 && port <= 65535 && port % 1 === 0)
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
		return uci.load('lwo');
	},

	render: function() {
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
			_('UDP port Mullvad LWO relays listen on — the same across relays (e.g. 33770). ' +
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
				E('p', {}, _('Save & Apply any changes to the relay list first, then switch.')),
				E('div', { 'class': 'cbi-value' }, [
					sel, ' ',
					btn.call(this, _('Switch to selected'), 'cbi-button-apply', function() {
						var ip = document.getElementById('lwo-relay-sel').value;
						return ip ? callSwitch(ip) : Promise.resolve();
					}),
					' ',
					btn.call(this, _('Next relay'), 'cbi-button-neutral', function() { return callNext(); }),
					' ',
					btn.call(this, _('Failover now'), 'cbi-button-neutral', function() { return callFailover(); })
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
