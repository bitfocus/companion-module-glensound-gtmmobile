'use strict'

const GS_MAGIC = Buffer.from('4753204374726c00', 'hex') // "GS Ctrl\0"
const CONTROLLER_ID = Buffer.from([0x6c, 0x80, 0x7b, 0xa2])

function buildCmd(cmdByte, val, p1, p2) {
	const b = Buffer.alloc(20)
	GS_MAGIC.copy(b, 0)
	b.writeUInt16LE(20, 8)
	b[10] = 3
	b[11] = 0
	CONTROLLER_ID.copy(b, 12)
	b[16] = cmdByte
	b[17] = val
	b[18] = p1
	b[19] = p2
	return b
}

const CMD_MUTE = buildCmd(19, 0, 5, 0)
const CMD_UNMUTE = buildCmd(19, 0, 4, 0)

// Mixer channel N (1-13) → param1 = N + 14
// Verified: channel 9 → param1 = 0x17 ✓
function buildChannelVolume(channel, volume) {
	const param1 = channel + 14
	const vol = Math.max(0, Math.min(100, Math.round(volume)))
	return buildCmd(0x0f, 0x00, param1, vol)
}

// Mic gain: cmdByte 0x05, val = dB + 8 (byte offset).
// Verified via Wireshark capture: 28/29/30 dB → 0x24/0x25/0x26.
// Range unconfirmed — clamped to 0-60dB as a safe placeholder, adjust to match your GTM's real range.
const GAIN_DB_OFFSET = 8
const GAIN_MIN_DB = 0
const GAIN_MAX_DB = 60
function buildMicGain(gainDb) {
	const clamped = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, Math.round(gainDb)))
	return buildCmd(0x05, clamped + GAIN_DB_OFFSET, 0x00, 0x00)
}

const CHANNEL_CHOICES = [
	{ id: 2, label: '2 - Game' },
	{ id: 3, label: '3 - Player 1' },
	{ id: 4, label: '4 - Player 2' },
	{ id: 5, label: '5 - Player 3' },
	{ id: 6, label: '6 - Player 4' },
	{ id: 7, label: '7 - Player 5' },
	{ id: 8, label: '8 - Player 6' },
	{ id: 9, label: '9 - Coach' },
	{ id: 10, label: '10 - Referee' },
	{ id: 11, label: '11 - Extra 1' },
	{ id: 12, label: '12 - Extra 2 (stereo)' },
	{ id: 13, label: '13 - Extra 3 (stereo)' },
	{ id: 14, label: '14 - Extra 4 (stereo)' },
]

function UpdateActions(self) {
	self.setActionDefinitions({
		mute: {
			name: 'Mute microphone',
			options: [],
			callback: () => {
				self.log('debug', 'Action: MUTE')
				self.sendCmd(CMD_MUTE)
			},
		},

		unmute: {
			name: 'Unmute microphone',
			options: [],
			callback: () => {
				self.log('debug', 'Action: UNMUTE')
				self.sendCmd(CMD_UNMUTE)
			},
		},

		toggle: {
			name: 'Toggle mute',
			options: [],
			callback: () => {
				self.log('debug', `Action: TOGGLE (state: ${self.muteState})`)
				self.sendToggle()
			},
		},

		channel_volume_100: {
			name: 'Set mixer channel to 100%',
			options: [
				{ type: 'dropdown', id: 'channel', label: 'Mixer channel', default: 9, choices: CHANNEL_CHOICES },
			],
			callback: (action) => {
				const ch = action.options.channel
				self.log('debug', `Action: CHANNEL ${ch} → 100%`)
				self.sendCmd(buildChannelVolume(ch, 100))
			},
		},

		channel_volume_0: {
			name: 'Set mixer channel to 0%',
			options: [
				{ type: 'dropdown', id: 'channel', label: 'Mixer channel', default: 9, choices: CHANNEL_CHOICES },
			],
			callback: (action) => {
				const ch = action.options.channel
				self.log('debug', `Action: CHANNEL ${ch} → 0%`)
				self.sendCmd(buildChannelVolume(ch, 0))
			},
		},

		channel_volume: {
			name: 'Set mixer channel volume',
			options: [
				{ type: 'dropdown', id: 'channel', label: 'Mixer channel', default: 9, choices: CHANNEL_CHOICES },
				{ type: 'number', id: 'volume', label: 'Volume (0–100)', min: 0, max: 100, default: 100 },
			],
			callback: (action) => {
				const { channel, volume } = action.options
				self.log('debug', `Action: CHANNEL ${channel} → ${volume}%`)
				self.sendCmd(buildChannelVolume(channel, volume))
			},
		},

		channel_volume_toggle: {
			name: 'Toggle mixer channel volume (0% ↔ 100%)',
			options: [
				{
					type: 'dropdown',
					id: 'channel',
					label: 'Mixer channel',
					default: 9,
					choices: CHANNEL_CHOICES,
				},
			],
			callback: (action) => {
				const ch = action.options.channel
				const current = self.channelVolumes[ch]
				const newVol = (current === null || current === undefined) ? 100 : current === 100 ? 0 : 100
				self.log('debug', `Action: TOGGLE VOLUME ch=${ch} ${current}% → ${newVol}%`)
				self.sendCmd(buildChannelVolume(ch, newVol))
			},
		},

		channel_volume_up: {
			name: 'Increase mixer channel volume',
			options: [
				{ type: 'dropdown', id: 'channel', label: 'Mixer channel', default: 9, choices: CHANNEL_CHOICES },
				{ type: 'number', id: 'step', label: 'Step (%)', min: 1, max: 100, default: 5 },
			],
			callback: (action) => {
				const ch = action.options.channel
				const step = action.options.step
				const current = self.channelVolumes[ch] ?? 0
				const newVol = Math.min(100, current + step)
				self.log('debug', `Action: CHANNEL ${ch} ${current}% → ${newVol}%`)
				self.sendCmd(buildChannelVolume(ch, newVol))
			},
		},

		channel_volume_down: {
			name: 'Decrease mixer channel volume',
			options: [
				{ type: 'dropdown', id: 'channel', label: 'Mixer channel', default: 9, choices: CHANNEL_CHOICES },
				{ type: 'number', id: 'step', label: 'Step (%)', min: 1, max: 100, default: 5 },
			],
			callback: (action) => {
				const ch = action.options.channel
				const step = action.options.step
				const current = self.channelVolumes[ch] ?? 0
				const newVol = Math.max(0, current - step)
				self.log('debug', `Action: CHANNEL ${ch} ${current}% → ${newVol}%`)
				self.sendCmd(buildChannelVolume(ch, newVol))
			},
		},

		// ── Mic gain ──────────────────────────────────────────────────────────

		mic_gain_set: {
			name: 'Set mic gain',
			options: [
				{
					type: 'number',
					id: 'gain',
					label: `Gain (dB, ${GAIN_MIN_DB}–${GAIN_MAX_DB})`,
					min: GAIN_MIN_DB,
					max: GAIN_MAX_DB,
					default: 30,
				},
			],
			callback: (action) => {
				const gain = action.options.gain
				self.log('debug', `Action: MIC GAIN → ${gain}dB`)
				self.sendCmd(buildMicGain(gain))
			},
		},

		mic_gain_up: {
			name: 'Increase mic gain',
			options: [
				{ type: 'number', id: 'step', label: 'Step (dB)', min: 1, max: 20, default: 1 },
			],
			callback: (action) => {
				const step = action.options.step
				const current = self.micGain ?? 0
				const newGain = current + step
				self.log('debug', `Action: MIC GAIN ${current}dB → ${newGain}dB`)
				self.sendCmd(buildMicGain(newGain))
			},
		},

		mic_gain_down: {
			name: 'Decrease mic gain',
			options: [
				{ type: 'number', id: 'step', label: 'Step (dB)', min: 1, max: 20, default: 1 },
			],
			callback: (action) => {
				const step = action.options.step
				const current = self.micGain ?? 0
				const newGain = current - step
				self.log('debug', `Action: MIC GAIN ${current}dB → ${newGain}dB`)
				self.sendCmd(buildMicGain(newGain))
			},
		},
	})
}

module.exports = { UpdateActions, CMD_MUTE, CMD_UNMUTE }
