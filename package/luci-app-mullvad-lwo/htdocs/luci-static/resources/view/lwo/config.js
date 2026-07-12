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

			var svcCtl = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Service control')),
				E('div', { 'class': 'cbi-value' }, [
					btn.call(this, _('Connect'), 'cbi-button-apply', function() { return callStart(); }), ' ',
					btn.call(this, _('Disconnect'), 'cbi-button-reset', function() { return callStop(); }), ' ',
					btn.call(this, _('Restart'), 'cbi-button-neutral', function() { return callRestart(); })
				])
			]);

			return E([], [ mapEl, relayCtl, svcCtl ]);
		}, this));
	}
});
