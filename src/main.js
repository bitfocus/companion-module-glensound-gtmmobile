'use strict'

const { InstanceBase, Regex, runEntrypoint, InstanceStatus } = require('@companion-module/base')
const { UpdateActions, CMD_MUTE, CMD_UNMUTE } = require('./actions')
const { UpdateFeedbacks } = require('./feedbacks')
const { UpdateVariables } = require('./variables')
const dgram = require('dgram')

// ─── GlenSound Protocol ────────────────────────────────────────────────────

const GS_MAGIC = Buffer.from('4753204374726c00', 'hex')
const CONTROLLER_ID = Buffer.from([0x6c, 0x80, 0x7b, 0xa2])

const STATUS_MULTICAST_GROUP = '239.254.50.123'
const STATUS_MULTICAST_PORT  = 6111

// Mute state: offset 0x81 in Status packet
// 0x01 = unmuted, 0x00 = muted
const MUTE_OFFSET = 0x81

// Channel volume report type=8
// Channels: knob 2-14, offset in packet = knob * 2 + 52
const REPORT_TYPE_VOLUME = 8
const CHANNEL_VOLUME_OFFSET = (knob) => knob * 2 + 52

// Generation counters in Status packet
const GEN_MUTE_OFFSET   = 0x1a
const GEN_VOLUME_OFFSET = 0x1c

// Channel range: knob 2-14 (channel 1/USB not controllable)
const CHANNEL_MIN = 2
const CHANNEL_MAX = 14

function buildPacket(opcode, payload) {
	const size = 16 + (payload ? payload.length : 0)
	const b = Buffer.alloc(size)
	GS_MAGIC.copy(b, 0)
	b.writeUInt16LE(size, 8)
	b[10] = opcode
	b[11] = 0x00
	CONTROLLER_ID.copy(b, 12)
	if (payload) payload.copy(b, 16)
	return b
}

const PKT_GET_STATUS = buildPacket(2)
const PKT_GET_REPORT_VOLUME = buildPacket(11, Buffer.from([REPORT_TYPE_VOLUME, 0x00, 0x00, 0x00]))

function findInterfaceForDevice(deviceIp) {
	const os = require('os')
	const deviceParts = deviceIp.split('.').map(Number)
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const addr of addrs) {
			if (addr.family !== 'IPv4' || addr.internal) continue
			const localParts = addr.address.split('.').map(Number)
			const maskParts  = addr.netmask.split('.').map(Number)
			const sameSubnet = maskParts.every((m, i) => (localParts[i] & m) === (deviceParts[i] & m))
			if (sameSubnet) return addr.address
		}
	}
	return undefined
}

// ─── Module ────────────────────────────────────────────────────────────────

class GlenSoundGTMMobile extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.muteState      = null
		this.channelVolumes = {}   // keyed by knob number 2-14
		this.lastGenMute    = -1
		this.lastGenVolume  = -1
		this.udpCmd         = null
		this.udpStatus      = null
		this.pollTimer      = null
		this.noResponseTimer = null
		this.membershipAdded = false
	}

	async init(config) {
		this.config = config
		this.updateStatus(InstanceStatus.Connecting)
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariables()
		this.start()
	}

	async destroy() {
		this.closeSockets()
	}

	async configUpdated(config) {
		this.config = config
		this.muteState = null
		this.channelVolumes = {}
		this.lastGenMute = -1
		this.lastGenVolume = -1
		// C15: await socket close before restarting
		await this.closeSockets()
		this.start()
	}

	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'Device IP address',
				width: 6,
				regex: Regex.IP,
				default: '192.168.1.100',
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'UDP command port',
				width: 3,
				regex: Regex.PORT,
				default: '41161',
			},
			{
				type: 'textinput',
				id: 'multicastInterface',
				label: 'Multicast interface IP (leave blank = auto)',
				width: 6,
				default: '',
				tooltip: 'Leave blank for auto-detection. Only set manually if auto-detection fails.',
			},
		]
	}

	updateActions()   { UpdateActions(this) }
	updateFeedbacks() { UpdateFeedbacks(this) }
	updateVariables() { UpdateVariables(this) }

	// ── Start ─────────────────────────────────────────────────────────────────

	start() {
		if (!this.config?.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'No device IP configured')
			return
		}

		// Command socket
		try {
			this.udpCmd = dgram.createSocket('udp4')
			this.udpCmd.on('error', (err) => this.log('error', `Cmd socket: ${err.message}`))
			this.udpCmd.bind(0, () => this.log('debug', `Cmd socket on port ${this.udpCmd.address().port}`))
		} catch (err) {
			this.log('error', `Failed to create cmd socket: ${err.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
			return
		}

		// Status multicast socket
		try {
			this.udpStatus = dgram.createSocket({ type: 'udp4', reuseAddr: true })
			this.udpStatus.on('error', (err) => {
			this.log('error', `Status socket: ${err.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		})
			this.udpStatus.on('message', (msg, rinfo) => this.onStatusMessage(msg, rinfo))

			this.udpStatus.bind(STATUS_MULTICAST_PORT, '0.0.0.0', () => {
				if (!this.udpStatus) return
				const configured = this.config?.multicastInterface
				const iface = configured || findInterfaceForDevice(this.config.host)
				if (!configured && iface) this.log('info', `Auto-detected multicast interface: ${iface}`)
				if (!configured && !iface) this.log('warn', 'Could not auto-detect multicast interface')
				try {
					this.udpStatus.addMembership(STATUS_MULTICAST_GROUP, iface)
					this.membershipAdded = true
					this.log('info', `Joined status multicast ${STATUS_MULTICAST_GROUP}:${STATUS_MULTICAST_PORT}`)
					this.updateStatus(InstanceStatus.Ok)
					this.sendCmd(PKT_GET_STATUS)
					this.sendCmd(PKT_GET_REPORT_VOLUME)
					this.pollTimer = setInterval(() => this.sendCmd(PKT_GET_STATUS), 500)
					this.resetTimeout()
				} catch (err) {
					this.log('error', `Multicast join failed: ${err.message}`)
					this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
				}
			})
		} catch (err) {
			this.log('error', `Failed to create status socket: ${err.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		}
	}

	// C15: closeSockets returns Promise for async safety
	closeSockets() {
		return new Promise((resolve) => {
			if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
			if (this.noResponseTimer) { clearTimeout(this.noResponseTimer); this.noResponseTimer = null
		this.membershipAdded = false }
			let pending = 0
			const done = () => { if (--pending === 0) resolve() }

			if (this.udpCmd) {
				pending++
				try { this.udpCmd.close(done) } catch (_) { done() }
				this.udpCmd = null
			}
			if (this.udpStatus) {
				pending++
				try {
					if (this.membershipAdded) { this.udpStatus.dropMembership(STATUS_MULTICAST_GROUP); this.membershipAdded = false }
					this.udpStatus.close(done)
				} catch (_) { done() }
				this.udpStatus = null
			}
			if (pending === 0) resolve()
		})
	}

	// ── Send ──────────────────────────────────────────────────────────────────

	sendCmd(pkt) {
		const host = this.config?.host
		const port = parseInt(this.config?.port) || 41161
		if (!host || !this.udpCmd) return
		this.udpCmd.send(pkt, 0, pkt.length, port, host, (err) => {
			if (err) {
				// C14: update status on send failure
				this.log('error', `Send error: ${err.message}`)
				this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
			}
		})
	}

	sendMute()   { this.sendCmd(CMD_MUTE);   this.log('debug', 'Sent MUTE') }
	sendUnmute() { this.sendCmd(CMD_UNMUTE); this.log('debug', 'Sent UNMUTE') }

	// M4: toggle does nothing when state unknown
	sendToggle() {
		if (this.muteState === null) {
			this.log('warn', 'Toggle ignored — mute state unknown, waiting for device response')
			return
		}
		this.muteState ? this.sendUnmute() : this.sendMute()
	}

	// ── Connection timeout ────────────────────────────────────────────────────

	resetTimeout() {
		if (this.noResponseTimer) clearTimeout(this.noResponseTimer)
		this.noResponseTimer = setTimeout(() => {
			this.log('warn', 'No response from device — connection lost')
			this.updateStatus(InstanceStatus.ConnectionFailure, 'No response')
			this.muteState = null
			this.channelVolumes = {}
			const vars = { mute_state: 'unknown' }
			for (let k = CHANNEL_MIN; k <= CHANNEL_MAX; k++) {
				vars[`channel_${k}_volume`] = 'unknown'
			}
			this.setVariableValues(vars)
			this.checkFeedbacks('mute_state', 'channel_volume')
		}, 3000)
	}

	// ── Parse Status multicast ────────────────────────────────────────────────

	onStatusMessage(msg, rinfo) {
		if (rinfo.port !== 41162) return
		if (rinfo.address !== this.config?.host) return
		if (msg.length < 16 || !msg.slice(0, 8).equals(GS_MAGIC)) return

		this.resetTimeout()
		if (this.instanceStatus !== InstanceStatus.Ok) this.updateStatus(InstanceStatus.Ok)
		const opcode = msg[10]

		if (opcode === 1) {
			this.onStatus(msg)
		} else if (opcode === 10) {
			this.onReport(msg)
		}
	}

	onStatus(msg) {
		if (msg.length <= MUTE_OFFSET) return

		const muteVal = msg[MUTE_OFFSET]
		const newMute = muteVal === 0x00
		if (newMute !== this.muteState) {
			this.muteState = newMute
			this.log('info', `Mute → ${newMute ? 'MUTED' : 'UNMUTED'}`)
			this.setVariableValues({ mute_state: newMute ? 'muted' : 'unmuted' })
			this.checkFeedbacks('mute_state')
		}

		if (msg.length > GEN_VOLUME_OFFSET) {
			const genVol = msg[GEN_VOLUME_OFFSET]
			if (genVol !== this.lastGenVolume) {
				this.lastGenVolume = genVol
				this.log('debug', `Volume generation changed (${genVol}), requesting report`)
				this.sendCmd(PKT_GET_REPORT_VOLUME)
			}
		}
	}

	onReport(msg) {
		if (msg.length < 20) return
		const reportType = msg[16]
		if (reportType !== REPORT_TYPE_VOLUME) return

		this.log('debug', `Volume report received, len=${msg.length}`)

		// C13: consistent channel range 2-14, stored by knob number
		let changed = false
		for (let knob = CHANNEL_MIN; knob <= CHANNEL_MAX; knob++) {
			const offset = CHANNEL_VOLUME_OFFSET(knob)
			if (offset >= msg.length) continue
			const vol = msg[offset]
			if (vol !== this.channelVolumes[knob]) {
				this.channelVolumes[knob] = vol
				this.log('debug', `Channel ${knob} volume = ${vol}%`)
				changed = true
			}
		}

		if (changed) {
			// C13: update variables for same range 2-14
			const vars = {}
			for (let k = CHANNEL_MIN; k <= CHANNEL_MAX; k++) {
				vars[`channel_${k}_volume`] = this.channelVolumes[k] !== undefined
					? `${this.channelVolumes[k]}%`
					: 'unknown'
			}
			this.setVariableValues(vars)
			this.checkFeedbacks('channel_volume')
		}
	}
}

runEntrypoint(GlenSoundGTMMobile, [])
