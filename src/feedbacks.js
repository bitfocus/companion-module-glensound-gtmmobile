'use strict'

const { combineRgb } = require('@companion-module/base')

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

function UpdateFeedbacks(self) {
	self.setFeedbackDefinitions({
		mute_state: {
			name: 'Microphone mute state',
			description: 'Changes button color based on mute/unmute state from device',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					type: 'dropdown',
					id: 'state',
					label: 'Trigger when device is',
					default: 'muted',
					choices: [
						{ id: 'muted', label: 'Muted' },
						{ id: 'unmuted', label: 'Unmuted' },
					],
				},
			],
			callback: (feedback) => {
				if (self.muteState === null) return false
				return feedback.options.state === 'muted' ? self.muteState === true : self.muteState === false
			},
		},

		channel_volume: {
			name: 'Mixer channel volume state',
			description: 'Changes button color based on channel volume (0% or 100%)',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(0, 180, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{ type: 'dropdown', id: 'channel', label: 'Mixer channel', default: 9, choices: CHANNEL_CHOICES },
				{
					type: 'dropdown',
					id: 'state',
					label: 'Trigger when channel is at',
					default: '100',
					choices: [
						{ id: '100', label: '100%' },
						{ id: '0', label: '0%' },
					],
				},
			],
			callback: (feedback) => {
				const ch = feedback.options.channel
				const vol = self.channelVolumes[ch]
				return vol != null && vol === parseInt(feedback.options.state)
			},
		},
	})
}

module.exports = { UpdateFeedbacks }
