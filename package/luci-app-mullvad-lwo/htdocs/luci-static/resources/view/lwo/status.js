'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

/* SPDX-License-Identifier: GPL-3.0-or-later */

var callStatus = rpc.declare({
	object: 'luci.lwo',
	method: 'status',
	expect: { }
});

function fmtBytes(n) {
	n = Number(n) || 0;
	var units = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ];
	var i = 0;
	while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
	return (i === 0 ? n : n.toFixed(2)) + ' ' + units[i];
}

function fmtHandshake(ts) {
	ts = Number(ts) || 0;
	if (ts === 0)
		return _('never');
	var delta = Math.floor(Date.now() / 1000) - ts;
	if (delta < 0) delta = 0;
	if (delta < 60) return _('%d seconds ago').format(delta);
	if (delta < 3600) return _('%d minutes ago').format(Math.floor(delta / 60));
	return _('%d hours ago').format(Math.floor(delta / 3600));
}

function isConnected(st) {
	var ts = Number(st.latest_handshake) || 0;
	if (ts === 0) return false;
	return (Math.floor(Date.now() / 1000) - ts) < 180; /* handshake within 3 min */
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '33%' }, label),
		E('td', { 'class': 'td left' }, value)
	]);
}

function badge(ok, okText, badText) {
	return E('span', {
		'style': 'color:#fff;padding:2px 8px;border-radius:3px;background:' +
			(ok ? '#4caf50' : '#f44336')
	}, ok ? okText : badText);
}

function renderTable(st) {
	return E('table', { 'class': 'table' }, [
		row(_('Running'), badge(!!st.running, _('yes'), _('no'))),
		row(_('Connected'), badge(isConnected(st), _('yes'), _('no'))),
		row(_('Interface'), st.interface || '-'),
		row(_('Endpoint'), st.server || '-'),
		row(_('Port'), st.server_port || '-'),
		row(_('Latest handshake'), fmtHandshake(st.latest_handshake)),
		row(_('Bytes received'), fmtBytes(st.rx_bytes)),
		row(_('Bytes sent'), fmtBytes(st.tx_bytes))
	]);
}

return view.extend({
	load: function() {
		return callStatus();
	},

	render: function(st) {
		var container = E('div', {}, renderTable(st || {}));

		poll.add(function() {
			return callStatus().then(function(fresh) {
				var fresh2 = E('div', {}, renderTable(fresh || {}));
				container.replaceChildren.apply(container, [].slice.call(fresh2.childNodes));
			});
		}, 5);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Mullvad LWO Status')),
			E('div', { 'class': 'cbi-section' }, [ container ])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
