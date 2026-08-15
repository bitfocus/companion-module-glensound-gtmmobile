'use strict'

function UpdateVariables(self) {
	const defs = [
		{ variableId: 'mute_state', name: 'Mute state (muted / unmuted / unknown)' },
		{ variableId: 'mic_gain', name: 'Mic gain (dB)' },
		{ variableId: 'mic_gain_raw', name: 'Mic gain, number only (for gauges)' },
		{ variableId: 'mic_level_db', name: 'Mic input level, number only (for gauges/meter bridge)' },
		{ variableId: 'mic_level_display', name: 'Mic input level (dB)' },
	]
	for (let k = 2; k <= 14; k++) {
		defs.push({ variableId: `channel_${k}_volume`, name: `Channel ${k} volume` })
		defs.push({ variableId: `channel_${k}_volume_raw`, name: `Channel ${k} volume, number only (for gauges)` })
	}
	self.setVariableDefinitions(defs)

	const vals = {
		mute_state: 'unknown',
		mic_gain: 'unknown',
		mic_gain_raw: '',
		mic_level_db: '',
		mic_level_display: 'unknown',
	}
	for (let k = 2; k <= 14; k++) {
		vals[`channel_${k}_volume`] = 'unknown'
		vals[`channel_${k}_volume_raw`] = ''
	}
	self.setVariableValues(vals)
}

module.exports = { UpdateVariables }
