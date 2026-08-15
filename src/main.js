'use strict'

const dgram = require('dgram')
const os = require('os')
const { InstanceBase, Regex, runEntrypoint, InstanceStatus } = require('@companion-module/base')
const { UpdateActions, CMD_MUTE, CMD_UNMUTE } = require('./actions')
const { UpdateFeedbacks } = require('./feedbacks')
const { UpdateVariables } = require('./variables')

const GS_MAGIC = Buffer.from('4753204374726c00', 'hex') // "GS Ctrl\0"
const CONTROLLER_ID = Buffer.from([0x6c, 0x80, 0x7b, 0xa2])

const STATUS_MULTICAST_GROUP = '239.254.50.123'
const STATUS_MULTICAST_PORT  = 6111

// Mute state: offset 0x81 in Status packet
// 0x01 = unmuted, 0x00 = muted
const MUTE_OFFSET = 0x81

// Mic input level meter: offset 44 in Status packet.
// Verified via 1kHz test tone across -42..+18dB: perfectly linear, 2 bytes per dB.
// dB = (METER_ZERO_BYTE - byte) / 2
const METER_OFFSET = 44
const METER_ZERO_BYTE = 36

// Channel volume report type=8
// Channels: knob 2-14, offset in packet = knob * 2 + 52
const REPORT_TYPE_VOLUME = 8
const CHANNEL_VOLUME_OFFSET = (knob) => knob * 2 + 52

// Mic gain report type=4 (verified via Wireshark capture)
// Value at payload offset 8 (absolute packet offset 24), encoded as dB + 8
const REPORT_TYPE_GAIN = 4
const GAIN_VALUE_OFFSET = 24
const GAIN_DB_OFFSET = 8

// reportType=1 — a combined "full status" report. Reverse-engineered from
// GlenSound Controller's own traffic: right after reconnecting, it requests
// this (not separate volume/gain requests) and GTM reliably answers it even
// when standalone GetReportVolume (type=8) goes unanswered after a reboot.
// It embeds shifted copies of the gain and volume sub-reports:
//   - gain value at absolute offset 44 (standalone GAIN_VALUE_OFFSET=24, +20 shift)
//   - channel volumes at knob*2+84 (standalone knob*2+52, +32 shift)
// Verified against multiple captured samples.
const REPORT_TYPE_FULL = 1
const FULL_GAIN_VALUE_OFFSET = 44
const FULL_CHANNEL_VOLUME_OFFSET = (knob) => knob * 2 + 84

// Exact lengths we've calibrated our fixed byte offsets against. GTM sends
// larger/differently-laid-out variants of these same report types while a
// preset is being pushed to the mixer (extra sub-blocks embedded in the
// packet) — reading our fixed offsets against those would silently produce
// garbage instead of real values. Until that expanded format is properly
// mapped, we only trust reports at exactly these known-good lengths and
// otherwise ignore the packet, keeping the last known-good value rather
// than showing something made up.
const KNOWN_VOLUME_LEN = 84
const KNOWN_FULL_LEN = 116

// Generation counters in Status packet
const GEN_MUTE_OFFSET   = 0x1a
const GEN_VOLUME_OFFSET = 0x1c

const CHANNEL_MIN = 2
const CHANNEL_MAX = 14

function buildPacket(opcode, payload) {
	const size = 16 + (payload ? payload.length : 0)
	const b = Buffer.alloc(size)
	GS_MAGIC.copy(b, 0)
	b.writeUInt16LE(size, 8)
	b[10] = opcode
	b[11] = 0
	CONTROLLER_ID.copy(b, 12)
	if (payload) payload.copy(b, 16)
	return b
}

const PKT_GET_STATUS = buildPacket(2)

// Controller registration/keepalive (opcode 7). Reverse-engineered from
// GlenSound Controller's own traffic: it sends this every ~1s using its own
// controller ID. GTM replies (opcode 6) confirming the status multicast
// group/port. Appears required for GTM to keep answering GetReportVolume
// for this controller — without periodic re-registration (e.g. after GTM
// reboots), volume reports stop coming back even though Status/gain/mute
// keep working fine (those are broadcast to everyone regardless).
const PKT_REGISTER = buildPacket(7)

const PKT_GET_REPORT_VOLUME = buildPacket(11, Buffer.from([REPORT_TYPE_VOLUME, 0x00, 0x00, 0x00]))
// UNVERIFIED: mirrors the volume request pattern (opcode 11, payload = report type).
const PKT_GET_REPORT_GAIN = buildPacket(11, Buffer.from([REPORT_TYPE_GAIN, 0x00, 0x00, 0x00]))
const PKT_GET_REPORT_FULL = buildPacket(11, Buffer.from([REPORT_TYPE_FULL, 0x00, 0x00, 0x00]))

// Finds a local IPv4 interface on the same subnet as the device, for
// multicast membership when the host has multiple NICs.
function autoDetectInterface(hostIp) {
	const hostOctets = hostIp.split('.').map(Number)
	for (const iface of Object.values(os.networkInterfaces())) {
		for (const addr of iface) {
			if (addr.family !== 'IPv4' || addr.internal) continue
			const ifaceOctets = addr.address.split('.').map(Number)
			const netmaskOctets = addr.netmask.split('.').map(Number)
			const sameSubnet = netmaskOctets.every((maskByte, i) => (ifaceOctets[i] & maskByte) === (hostOctets[i] & maskByte))
			if (sameSubnet) return addr.address
		}
	}
}

class GlenSoundGTMMobile extends InstanceBase {
	constructor(internal) {
		super(internal)

		this.muteState      = null
		this.channelVolumes = {}   // keyed by knob number 2-14
		this.micGain        = null // dB, from gain report (reportType=4)
		this.micLevel       = null // dB, from Status packet meter offset
		this.micLevelSmoothed = null // dB, after attack/release smoothing
		this.lastMeterUpdate = null // Date.now() of last smoothing step
		this.deviceOnline    = true // explicit flag: were we in a "no response" state?
		this.reconnectRetryTimer = null
		this.lastGenMute    = -1
		this.lastGenVolume  = -1

		this.udpCmd         = null
		this.udpStatus      = null
		this.pollTimer      = null
		this.volumePollTimer = null
		this.gainPollTimer  = null
		this.fullPollTimer  = null
		this.registerTimer  = null
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
		this.micGain = null
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
			{
				type: 'number',
				id: 'meterReleaseDbPerSec',
				label: 'Meter release speed (dB/sec)',
				width: 4,
				min: 1,
				max: 60,
				default: 42,
				tooltip: 'How fast the mic level meter falls back down after a peak. Lower = smoother/slower, higher = snappier/more jumpy. Rise is always instant.',
			},
		]
	}

	updateActions()   { UpdateActions(this) }
	updateFeedbacks() { UpdateFeedbacks(this) }
	updateVariables() { UpdateVariables(this) }

	// ── Command socket lifecycle ────────────────────────────────────────────

	createCmdSocket() {
		try {
			this.udpCmd = dgram.createSocket('udp4')
			this.udpCmd.on('error', (err) => this.log('error', `Cmd socket: ${err.message}`))
			this.udpCmd.bind(0, () => this.log('debug', `Cmd socket bound, local port ${this.udpCmd.address().port}`))
			return true
		} catch (err) {
			this.log('error', `Failed to create cmd socket: ${err.message}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
			return false
		}
	}

	// Windows can "poison" a UDP socket after it receives an ICMP Port
	// Unreachable (e.g. while the device is mid-reboot) — sends silently keep
	// failing on that socket even after the device is back online. Recreating
	// the socket from scratch clears that state. Only the cmd socket needs
	// this; the status multicast socket is receive-only and unaffected.
	recreateCmdSocket() {
		this.log('debug', 'Recreating cmd socket (in case it was poisoned by the outage)')
		if (this.udpCmd) {
			try { this.udpCmd.close() } catch (_) { /* ignore */ }
			this.udpCmd = null
		}
		this.createCmdSocket()
	}

	// ── Start ─────────────────────────────────────────────────────────────────

	start() {
		if (!this.config?.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'No device IP configured')
			return
		}

		// Command socket
		if (!this.createCmdSocket()) return

		// Status multicast socket
		try {
			this.udpStatus = dgram.createSocket({ type: 'udp4', reuseAddr: true })
			this.udpStatus.on('error', (err) => {
				this.log('error', `Status socket: ${err.message}`)
				this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
			})
			this.udpStatus.on('message', (msg, rinfo) => this.onStatusMessage(msg, rinfo))
			// C12: bind to 0.0.0.0 instead of the multicast group address to fix
			// EADDRNOTAVAIL on multi-interface Windows systems
			this.udpStatus.bind(STATUS_MULTICAST_PORT, '0.0.0.0', () => {
				if (!this.udpStatus) return

				const configured = this.config?.multicastInterface
				const iface = configured || autoDetectInterface(this.config.host)
				if (!configured && iface) this.log('info', `Auto-detected multicast interface: ${iface}`)
				if (!configured && !iface) this.log('warn', 'Could not auto-detect multicast interface')

				try {
					this.udpStatus.addMembership(STATUS_MULTICAST_GROUP, iface)
					this.membershipAdded = true
					this.log('info', `Joined status multicast ${STATUS_MULTICAST_GROUP}:${STATUS_MULTICAST_PORT}`)
					this.updateStatus(InstanceStatus.Ok)

					this.sendCmd(PKT_GET_STATUS)
					this.sendCmd(PKT_REGISTER)
					this.sendCmd(PKT_GET_REPORT_FULL)
					this.sendCmd(PKT_GET_REPORT_VOLUME)
					this.sendCmd(PKT_GET_REPORT_GAIN) // unverified request, see comment above PKT_GET_REPORT_GAIN
					this.pollTimer = setInterval(() => this.sendCmd(PKT_GET_STATUS), 500)
					this.registerTimer = setInterval(() => this.sendCmd(PKT_REGISTER), 1000)
					this.volumePollTimer = setInterval(() => this.sendCmd(PKT_GET_REPORT_VOLUME), 5000)
					this.gainPollTimer = setInterval(() => this.sendCmd(PKT_GET_REPORT_GAIN), 5000)
					this.fullPollTimer = setInterval(() => this.sendCmd(PKT_GET_REPORT_FULL), 5000)
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

	closeSockets() {
		return new Promise((resolve) => {
			if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
			if (this.volumePollTimer) { clearInterval(this.volumePollTimer); this.volumePollTimer = null }
			if (this.gainPollTimer) { clearInterval(this.gainPollTimer); this.gainPollTimer = null }
			if (this.fullPollTimer) { clearInterval(this.fullPollTimer); this.fullPollTimer = null }
			if (this.registerTimer) { clearInterval(this.registerTimer); this.registerTimer = null }
			if (this.noResponseTimer) { clearTimeout(this.noResponseTimer); this.noResponseTimer = null }
			this.membershipAdded = false
			if (this.reconnectRetryTimer) { clearTimeout(this.reconnectRetryTimer); this.reconnectRetryTimer = null }

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
					if (this.membershipAdded) {
						this.udpStatus.dropMembership(STATUS_MULTICAST_GROUP)
						this.membershipAdded = false
					}
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
		if (!host) { this.log('warn', `sendCmd: no host configured, dropping ${pkt.toString('hex')}`); return }
		if (!this.udpCmd) { this.log('warn', `sendCmd: no cmd socket available, dropping ${pkt.toString('hex')}`); return }
		this.log('debug', `→ sending to ${host}:${port}: ${pkt.toString('hex')}`)
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
			this.deviceOnline = false
			this.muteState = null
			this.channelVolumes = {}
			this.micGain = null
			this.micLevel = null
			this.micLevelSmoothed = null
			this.lastMeterUpdate = null
			const vars = {
				mute_state: 'unknown',
				mic_gain: 'unknown',
				mic_gain_raw: '',
				mic_level_db: '',
				mic_level_display: 'unknown',
			}
			for (let k = CHANNEL_MIN; k <= CHANNEL_MAX; k++) {
				vars[`channel_${k}_volume`] = 'unknown'
				vars[`channel_${k}_volume_raw`] = ''
			}
			this.setVariableValues(vars)
			this.checkFeedbacks('mute_state', 'channel_volume')
		}, 3000)
	}

	// ── Incoming ─────────────────────────────────────────────────────────────

	onStatusMessage(msg, rinfo) {
		if (rinfo.port !== 41162) return
		if (rinfo.address !== this.config?.host) return
		if (msg.length < 16 || !msg.slice(0, 8).equals(GS_MAGIC)) return

		this.resetTimeout()
		if (!this.deviceOnline) {
			this.deviceOnline = true
			this.log('info', 'Device back online — re-syncing volume/gain state')
			this.recreateCmdSocket()
			this.sendCmd(PKT_REGISTER)
			this.sendCmd(PKT_GET_REPORT_FULL) // this is what actually works after a reboot — see REPORT_TYPE_FULL comment
			this.sendCmd(PKT_GET_REPORT_VOLUME)
			this.sendCmd(PKT_GET_REPORT_GAIN) // unverified request, see comment above PKT_GET_REPORT_GAIN
			// Quick follow-up retry: right after a reboot the device's Status/multicast
			// responder can come up before its mixer subsystem is ready to answer
			// GetReportVolume/GetReportGain, so the first request can silently go
			// unanswered. Retry once more shortly after, instead of only relying on
			// the 5s periodic poll.
			if (this.reconnectRetryTimer) clearTimeout(this.reconnectRetryTimer)
			this.reconnectRetryTimer = setTimeout(() => {
				this.reconnectRetryTimer = null
				this.log('debug', 'Reconnect retry: re-requesting volume/gain report')
				this.sendCmd(PKT_REGISTER)
				this.sendCmd(PKT_GET_REPORT_FULL)
				this.sendCmd(PKT_GET_REPORT_VOLUME)
				this.sendCmd(PKT_GET_REPORT_GAIN)
			}, 2000)
		}
		this.updateStatus(InstanceStatus.Ok)

		const opcode = msg[10]
		if (opcode === 1) {
			this.onStatus(msg)
		} else if (opcode === 10) {
			this.onReport(msg)
		}
	}

	onStatus(msg) {
		if (msg.length <= MUTE_OFFSET) return

		const newMute = msg[MUTE_OFFSET] === 0
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

		if (msg.length > METER_OFFSET) {
			const raw = msg[METER_OFFSET]
			const levelDb = (METER_ZERO_BYTE - raw) / 2
			this.micLevel = levelDb

			const now = Date.now()
			if (this.micLevelSmoothed === null) {
				this.micLevelSmoothed = levelDb
			} else if (levelDb >= this.micLevelSmoothed) {
				// Instant attack — meter jumps up immediately on a louder signal
				this.micLevelSmoothed = levelDb
			} else {
				// Gradual release — meter falls back down at a limited dB/sec rate
				const dtSec = (now - (this.lastMeterUpdate ?? now)) / 1000
				const releaseRate = Number(this.config?.meterReleaseDbPerSec) || 42
				const maxDrop = releaseRate * dtSec
				this.micLevelSmoothed = Math.max(levelDb, this.micLevelSmoothed - maxDrop)
			}
			this.lastMeterUpdate = now

			const displayVal = Math.round(this.micLevelSmoothed * 10) / 10
			this.setVariableValues({ mic_level_db: displayVal, mic_level_display: `${displayVal}dB` })
		}
	}

	onReport(msg) {
		if (msg.length < 20) return
		const reportType = msg[16]
		this.log('debug', `← report received (type=${reportType}, len=${msg.length}): ${msg.toString('hex')}`)
		if (reportType === REPORT_TYPE_VOLUME) {
			if (msg.length !== KNOWN_VOLUME_LEN) {
				this.log('debug', `Ignoring volume report with unexpected length ${msg.length} (expected ${KNOWN_VOLUME_LEN}) — likely a preset-push variant we haven't mapped yet`)
				return
			}
			this.onVolumeReport(msg)
		} else if (reportType === REPORT_TYPE_GAIN) {
			this.onGainReport(msg)
		} else if (reportType === REPORT_TYPE_FULL) {
			if (msg.length !== KNOWN_FULL_LEN) {
				this.log('debug', `Ignoring full report with unexpected length ${msg.length} (expected ${KNOWN_FULL_LEN}) — likely a preset-push variant we haven't mapped yet`)
				return
			}
			this.onFullReport(msg)
		}
	}

	onVolumeReport(msg, offsetFn = CHANNEL_VOLUME_OFFSET) {
		this.log('debug', `Volume report received, len=${msg.length}`)

		// C13: consistent channel range 2-14, stored by knob number
		let changed = false
		for (let knob = CHANNEL_MIN; knob <= CHANNEL_MAX; knob++) {
			const offset = offsetFn(knob)
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
				const vol = this.channelVolumes[k]
				vars[`channel_${k}_volume`] = vol !== undefined ? `${vol}%` : 'unknown'
				vars[`channel_${k}_volume_raw`] = vol !== undefined ? vol : ''
			}
			this.setVariableValues(vars)
			this.checkFeedbacks('channel_volume')
		}
	}

	onGainReport(msg, valueOffset = GAIN_VALUE_OFFSET) {
		if (msg.length <= valueOffset) return
		const gainDb = msg[valueOffset] - GAIN_DB_OFFSET
		if (gainDb !== this.micGain) {
			this.micGain = gainDb
			this.log('debug', `Mic gain = ${gainDb}dB`)
			this.setVariableValues({ mic_gain: `${gainDb}dB`, mic_gain_raw: gainDb })
		}
	}

	// Combined "full status" report (see REPORT_TYPE_FULL comment above).
	// Reuses the same volume/gain parsing logic, just at shifted offsets.
	onFullReport(msg) {
		this.log('debug', `Full report received, len=${msg.length}`)
		this.onGainReport(msg, FULL_GAIN_VALUE_OFFSET)
		this.onVolumeReport(msg, FULL_CHANNEL_VOLUME_OFFSET)
	}
}

runEntrypoint(GlenSoundGTMMobile, [])
