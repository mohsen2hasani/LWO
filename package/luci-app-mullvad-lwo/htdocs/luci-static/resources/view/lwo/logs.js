'use strict';
'require view';
'require rpc';
'require poll';

/* SPDX-License-Identifier: GPL-3.0-or-later */

var callLogs = rpc.declare({
	object: 'luci.lwo',
	method: 'logs',
	expect: { log: '' }
});

return view.extend({
	load: function() {
		return callLogs();
	},

	render: function(log) {
		var area = E('textarea', {
			'id': 'lwo-logs',
			'style': 'width:100%;min-height:60vh;font-family:monospace',
			'readonly': 'readonly',
			'wrap': 'off'
		}, log || _('No log entries.'));

		poll.add(function() {
			return callLogs().then(function(fresh) {
				area.value = fresh || '';
			});
		}, 5);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Mullvad LWO Logs')),
			E('div', { 'class': 'cbi-section' }, [
				E('p', {}, _('Last 200 log lines (auto-refreshing).')),
				area
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
