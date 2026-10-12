import AVFAudio
import Foundation
import WatchKit

// S105: the watch's own audio leg. WebSocket to the watch-audio bridge (hello → ready → PCM16 frames), AVAudioEngine
// under the CallKit-activated session. Capture/convert path is lifted from the spike (WatchAudioLoopbackView.swift).
// Wire frame (both directions): 4 B BE seq + 8 B BE monotonic ns + payload of `frameMs`: 16 kHz Int16 mono PCM
// (`pcm16k`) or one Opus packet (`opus16k`, S112; encoded/decoded at the send/handle boundary, the engine stays PCM).

/// VoDog: `wss://<host>/ws/watch-audio` on the optional relay host when configured, else the main VoDog host.
let watchAudioURL: URL = {
    var parts = URLComponents(url: AppRuntimeConfiguration.relayAPIBaseURL ?? AppRuntimeConfiguration.productionAPIBaseURL,
                              resolvingAgainstBaseURL: false)!
    parts.scheme = "wss"; parts.path = "/ws/watch-audio"
    return parts.url!
}()
private let readyTimeout: Duration = .seconds(30) // socket open (8 s seen on watch Wi-Fi) + bridge media connect (≤20 s)
/// Also the CallKit start-retry schedule (WatchCallKit.startLeg).
let reconnectDelays: [Duration] = [.seconds(1), .seconds(3), .seconds(5)]
/// S108: after the listed delays, keep retrying every 5 s up to this many attempts (≈90 s) — a watch walking out of
/// the iPhone's Bluetooth range needs Wi-Fi / LTE to come up first.
let reconnectMaxAttempts = 20
/// S108: no frame and no pong for this long on a ready socket = the path died silently (BT proxy → Wi-Fi/LTE switch
/// leaves the TCP connection "open" on both ends); treat as lost and reconnect over the new path.
let stallTimeout: Duration = .seconds(5)
private let pingInterval: Duration = .seconds(2)
private let headerBytes = 12

private func monotonicNs() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

struct WatchAudioLegError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Audio-thread side: mic → 16 kHz Int16 frames; inbound frames → adaptive jitter FIFO → player. Never touches the main actor.
final class WatchAudioEngine: @unchecked Sendable {
    struct Snapshot: Sendable {
        var levelDb: Float = -160; var underruns = 0; var restarts = 0; var targetMs = 80; var depthMs = 0
        var tails = 0 // S108 underrun tail fades queued
        var firstPlayMs: Int? // engine start → first downlink buffer consumed (uplink gate opens)
        var prerollMs: Int? // engine start → first real downlink frame scheduled (silence pre-roll ends)
    }

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
    private let pcm16 = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private let frameMs: Int
    private let frameSamples: Int
    private let silence: Data
    private var converter: AVAudioConverter? // tap thread only
    private var pending: [Int16] = [] // tap thread only

    private let lock = NSLock()
    private var snap = Snapshot()
    private var running = false
    private var muted = false
    // Jitter buffer: frames wait here; only `maxScheduled` sit in the player so overflow can drop the oldest.
    private var fifo: [Data] = []
    private var scheduled = 0
    private var playing = false
    private var lastArrivalNs: UInt64 = 0
    private var jitterMs: [Double] = []
    private var startedOnce = false
    // S105f: at ×2.8 a 5 ms ramp still popped. 30 ms linear fade-in (continued across buffers) after every (re)start.
    private static let fadeInSamples = 480 // 30 ms at 16 kHz
    private var fadePos = fadeInSamples
    // Uplink: silent until the first downlink buffer is consumed, then 30 ms fade-in; mute/unmute ramp 10 ms.
    private var uplinkOpen = false
    private var uplinkStep: Float = 1 / 480 // per-sample gain step toward the target
    private var upGain: Float = 0 // tap thread only
    private var startedNs: UInt64 = 0
    // S105g: from engine start until the first real frame, the player is kept fed with 20 ms silent buffers so the
    // output hardware is already rendering when audio begins (separate counter: never touches `scheduled`/uplink gate).
    private var prerolling = false
    private var prerollQueued = 0
    private lazy var prerollBuf: AVAudioPCMBuffer = {
        let b = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: 320)! // 20 ms, zero-filled
        b.frameLength = 320
        return b
    }()
    // S105g: last ≤40 ms of scheduled (post-gain) samples; the stop fade extends it mirrored, ramped to 0.
    private static let ringSamples = 640
    private var ring: [Float] = []
    private var fadeResume: CheckedContinuation<Void, Never>?
    /// S108: a mirrored-tail fade is queued behind the last real buffer when the jitter buffer runs dry, so an underrun
    /// ends in a ramp to zero instead of a cut (the "个别爆音" with AEC on: more restarts, each one a cut).
    private var tailQueued = false
    // `.dataConsumed` frees a slot when the player dequeues a buffer, so 4 keeps the player fed through callback lag.
    private let maxScheduled = 4
    /// S112c: the Bluetooth-proxied path shows 0.5–1.2 s jitter spikes (rtt p95; S105 spike measured p95 1.2 s); a 200 ms
    /// cap left 9 underruns in 50 s, each one a fade-out/fade-in the user hears as a pop. The target still follows the
    /// measured p95 (80 ms on a clean path); only the ceiling moves, so latency grows only when the path is jittery.
    private let minTargetMs = 80, maxTargetMs = 400
    /// S105d: downlink digital gain, applied only on the Int16 → Float32 playback path, followed by a `tanh` soft
    /// limiter so peaks never clip hard. S126: the Pixel gateway now levels the far end to −20 dBFS before encoding
    /// (the raw bridge PCM used to sit 10–14 dB lower, hence the old ×2.8); unity here, or the leveled stream saturates.
    static let downlinkGain: Float = 1.0
    /// S105m: Apple's voice-processing I/O (echo cancellation + noise suppression + AGC, what the system Phone app
    /// uses). The session's `.voiceChat` mode alone does not enable it for AVAudioEngine: the 10010 IVR heard its own
    /// prompts echoed back (−60 dBFS, ~1 s late) and kept jumping menus. Must be set before the engine starts and
    /// before the graph is wired, because it changes the I/O node formats.
    /// S105n/S106: enabling it *before* the output chain exists (TestFlight 104) starts the engine but the I/O never
    /// runs (two silent calls). The S106 loopback spike found the working order on a real Ultra 2 / watchOS 27
    /// (variant B): touch `outputNode` + `mainMixerNode` first, then enable, then wire; tap with `format: nil`.
    /// Enabling after `prepare()` fails with -10849.
    static let voiceProcessing = true
    private(set) var aec = "off"
    private(set) var inputSampleRate: Double = 0

    init(frameMs: Int) {
        self.frameMs = frameMs
        frameSamples = 16 * frameMs
        silence = Data(count: 16 * frameMs * 2)
    }

    var snapshot: Snapshot {
        lock.withLock {
            var s = snap
            s.depthMs = (fifo.count + scheduled) * frameMs
            return s
        }
    }
    var isRunning: Bool { engine.isRunning }
    func setMuted(_ value: Bool) { lock.withLock { muted = value; uplinkStep = 1 / 160 } } // 10 ms ramp

    /// Call after the audio session is active (input format is 0 Hz before). `onFrame` runs on the tap thread.
    func start(onFrame: @escaping @Sendable (Data) -> Void) throws {
        if Self.voiceProcessing {
            _ = engine.outputNode; _ = engine.mainMixerNode // S106 variant B: the output chain must exist first
            do { try engine.inputNode.setVoiceProcessingEnabled(true); aec = "on" } catch { aec = "error:\(error.localizedDescription)" }
        }
        engine.attach(player)
        // One Float32 graph: Int16 → Float32 is scaled exactly once (in `schedule`), mixer and player at unity.
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        player.volume = 1
        engine.mainMixerNode.outputVolume = 1
        let input = engine.inputNode
        let hw = input.outputFormat(forBus: 0)
        inputSampleRate = hw.sampleRate
        guard hw.sampleRate > 0, let conv = AVAudioConverter(from: hw, to: pcm16) else {
            throw WatchAudioLegError(message: "无麦克风输入格式（\(hw.sampleRate) Hz）")
        }
        converter = conv
        // S106 variant B: `nil` = the node's own (post-voice-processing) format; the converter follows the buffer.
        input.installTap(onBus: 0, bufferSize: 1024, format: Self.voiceProcessing ? nil : hw) { @Sendable [weak self] buffer, _ in
            self?.capture(buffer, onFrame: onFrame)
        }
        lock.withLock { running = true; startedNs = monotonicNs() }
        engine.prepare()
        try engine.start()
        player.play()
        lock.withLock { prerolling = true; feedPreroll() }
    }

    /// Lock held. Keeps ~4 silent 20 ms buffers queued while pre-rolling.
    private func feedPreroll() {
        while prerolling, running, prerollQueued < 4 {
            prerollQueued += 1
            player.scheduleBuffer(prerollBuf, completionCallbackType: .dataConsumed) { @Sendable [weak self] _ in
                guard let self else { return }
                self.lock.withLock { self.prerollQueued -= 1; self.feedPreroll() }
            }
        }
    }

    /// S105g sample-level fade-out; call before `stop()`. Stops scheduling, mutes the uplink (10 ms ramp, held ≥20 ms
    /// before the tap goes), lets the already-queued frames play out, then plays the last ≤40 ms mirrored × 1→0 ramp
    /// + 20 ms silence and awaits its `.dataPlayedBack`. Returns elapsed ms, or nil when nothing was audible (starved,
    /// pre-roll only, or engine already stopped) — fading stale ring samples would itself pop.
    // ponytail: drains rather than `player.stop()` (an instant cut); wait bounded by queued (+pre-roll) + 60 ms, ≤~300 ms.
    func fadeOut() async -> Int? {
        let began = monotonicNs()
        setMuted(true)
        let (queued, silent, tail): (Int, Int, [Float]) = lock.withLock {
            running = false; prerolling = false; fifo = []; playing = false
            return (scheduled, prerollQueued, ring)
        }
        let fadeLen = tail.count
        guard engine.isRunning, queued > 0, fadeLen > 0,
              let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(fadeLen + 320)),
              let dst = buf.floatChannelData?[0] else {
            try? await Task.sleep(for: .milliseconds(20)) // uplink zeroed for 20 ms before the tap is removed
            return nil
        }
        buf.frameLength = AVAudioFrameCount(fadeLen + 320)
        for i in 0..<fadeLen { dst[i] = tail[fadeLen - 1 - i] * Float(fadeLen - 1 - i) / Float(fadeLen) }
        for i in fadeLen..<(fadeLen + 320) { dst[i] = 0 }
        let timeoutMs = queued * frameMs + silent * 20 + 60 // + pre-roll silence still ahead of the frames
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            lock.withLock { fadeResume = c }
            player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { @Sendable [weak self] _ in self?.resumeFade() }
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in self?.resumeFade() }
        }
        return Int((monotonicNs() - began) / 1_000_000)
    }

    private func resumeFade() {
        lock.withLock { () -> CheckedContinuation<Void, Never>? in
            defer { fadeResume = nil }
            return fadeResume
        }?.resume()
    }

    /// Tears the graph down; after `fadeOut()` the output is already silent. Safe to call twice.
    func stop() {
        lock.withLock { running = false; prerolling = false; fifo = []; playing = false }
        player.pause()
        engine.mainMixerNode.outputVolume = 0
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        lock.withLock { scheduled = 0 }
    }

    private func capture(_ buffer: AVAudioPCMBuffer, onFrame: (Data) -> Void) {
        if let c = converter, c.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: pcm16) } // tap format nil (S106 B)
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000 / buffer.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: pcm16, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard let ch = out.int16ChannelData, out.frameLength > 0 else { return }
        let samples = UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength))
        let level = Self.rmsDb(samples) // on the Int16 capture (the spike's float read gave -160)
        pending.append(contentsOf: samples)
        var frames: [Data] = []
        while pending.count >= frameSamples {
            frames.append(pending[0..<frameSamples].withUnsafeBytes { Data($0) })
            pending.removeFirst(frameSamples)
        }
        let (target, step): (Float, Float) = lock.withLock {
            snap.levelDb = level
            // Safety: never hold the uplink silent for more than 2 s if downlink never plays (one-way audio).
            if !uplinkOpen, monotonicNs() - startedNs > 2_000_000_000 { uplinkOpen = true; uplinkStep = 1 / 480 }
            return (uplinkOpen && !muted ? 1 : 0, uplinkStep)
        }
        for frame in frames {
            if upGain == target {
                onFrame(target == 0 ? silence : frame)
                continue
            }
            var ramped = frame
            ramped.withUnsafeMutableBytes { raw in
                let s = raw.bindMemory(to: Int16.self)
                for i in s.indices {
                    upGain = target > upGain ? min(target, upGain + step) : max(target, upGain - step)
                    s[i] = Int16(Float(s[i]) * upGain)
                }
            }
            onFrame(ramped)
        }
    }

    /// Thread-safe. `pcm` is 16 kHz Int16 mono. `missing` = sequence gap before it: PLC-lite plays one silent frame
    /// per missing frame (capped below the buffer size so drop-oldest never discards the real frame).
    func play(_ pcm: Data, missing: Int = 0) {
        lock.withLock {
            guard running else { return }
            noteArrival()
            let maxFrames = maxTargetMs / frameMs
            for _ in 0..<max(0, min(missing, maxFrames - 1)) { fifo.append(silence) }
            fifo.append(pcm)
            while fifo.count + scheduled > maxFrames, !fifo.isEmpty { fifo.removeFirst() } // drop oldest
            if !playing, fifo.count * frameMs >= snap.targetMs {
                playing = true
                fadePos = 0
                tailQueued = false
                if prerolling { prerolling = false; snap.prerollMs = Int((monotonicNs() - startedNs) / 1_000_000) }
                if startedOnce { snap.restarts += 1 }
                startedOnce = true
            }
            if playing { topUp() }
        }
        if !player.isPlaying, lock.withLock({ running && playing }) { player.play() }
    }

    /// Lock held. Target depth = frame + p95 of inter-arrival deviation, clamped 80–200 ms, re-derived every 25 frames.
    // ponytail: p95 over a 100-arrival window; switch to an RFC 3550 jitter estimator if this hunts.
    private func noteArrival() {
        let now = monotonicNs()
        defer { lastArrivalNs = now }
        guard lastArrivalNs != 0 else { return }
        jitterMs.append(max(0, Double(now - lastArrivalNs) / 1e6 - Double(frameMs)))
        if jitterMs.count > 100 { jitterMs.removeFirst(jitterMs.count - 100) }
        guard jitterMs.count % 25 == 0 else { return }
        let sorted = jitterMs.sorted()
        let p95 = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
        snap.targetMs = min(maxTargetMs, max(minTargetMs, frameMs + Int(p95.rounded(.up))))
    }

    /// Lock held. scheduleBuffer never calls back synchronously while playing, so holding the lock keeps order.
    private func topUp() {
        if tailQueued, !fifo.isEmpty { tailQueued = false; fadePos = 0 } // audio resumes behind a tail: fade it in
        while scheduled < maxScheduled, !fifo.isEmpty {
            let pcm = fifo.removeFirst()
            let n = pcm.count / 2
            guard let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(n)),
                  let dst = buf.floatChannelData?[0] else { continue }
            buf.frameLength = AVAudioFrameCount(n)
            pcm.withUnsafeBytes { raw in
                for i in 0..<n {
                    dst[i] = tanh(Float(raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)) / 32768 * Self.downlinkGain)
                }
            }
            var i = 0
            while fadePos < Self.fadeInSamples, i < n {
                dst[i] *= Float(fadePos) / Float(Self.fadeInSamples)
                fadePos += 1; i += 1
            }
            ring.append(contentsOf: UnsafeBufferPointer(start: dst, count: n))
            if ring.count > Self.ringSamples { ring.removeFirst(ring.count - Self.ringSamples) }
            scheduled += 1
            player.scheduleBuffer(buf, completionCallbackType: .dataConsumed) { @Sendable [weak self] _ in self?.didPlay() }
        }
    }

    private func didPlay() {
        lock.withLock {
            guard running else { return }
            scheduled -= 1
            if !uplinkOpen {
                uplinkOpen = true
                uplinkStep = 1 / 480 // 30 ms fade-in
                snap.firstPlayMs = Int((monotonicNs() - startedNs) / 1_000_000)
            }
            topUp()
            if scheduled == 1, fifo.isEmpty, playing, !tailQueued { queueTail() } // the last real buffer just started
            if scheduled == 0 && playing { snap.underruns += 1; playing = false } // re-prebuffer to target
        }
    }

    /// Lock held. Last ≤40 ms mirrored × 1→0 behind the buffer now playing, then 20 ms silence; counts as scheduled so
    /// the underrun is noticed when it has played. The ring is spent: the next audio fades in from zero.
    private func queueTail() {
        let tail = ring
        ring = []
        tailQueued = true
        let fadeLen = tail.count
        guard fadeLen > 0, let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(fadeLen + 320)),
              let dst = buf.floatChannelData?[0] else { return }
        buf.frameLength = AVAudioFrameCount(fadeLen + 320)
        for i in 0..<fadeLen { dst[i] = tail[fadeLen - 1 - i] * Float(fadeLen - 1 - i) / Float(fadeLen) }
        for i in fadeLen..<(fadeLen + 320) { dst[i] = 0 }
        scheduled += 1
        snap.tails += 1
        player.scheduleBuffer(buf, completionCallbackType: .dataConsumed) { @Sendable [weak self] _ in self?.didPlay() }
    }

    static func rmsDb(_ samples: UnsafeBufferPointer<Int16>) -> Float {
        guard !samples.isEmpty else { return -160 }
        var sum: Double = 0
        for s in samples { let v = Double(s) / 32768; sum += v * v }
        return Float(max(-160, 10 * log10(sum / Double(samples.count) + 1e-16)))
    }
}

/// Main-actor side: WebSocket lifecycle, reconnect, RTT, route, stats.
@MainActor
final class WatchAudioLeg: WatchAudioLegging {
    let stats = WatchAudioStats()

    private var callId = ""
    private var token = ""
    private var frameMs = 40
    private var live = false // between start and stop
    private var audio: WatchAudioEngine?
    private var manuallyActivated = false
    private var socket: URLSessionWebSocketTask?
    private var prewarmed: (task: URLSessionWebSocketTask, token: String)? // opened at ring/dial, idle until start
    private var socketReady = false
    private var reconnecting = false
    private var muted = false
    private var tasks: [Task<Void, Never>] = [] // activation fallback, stats poll, ping, route observer
    private var receiveTask: Task<Void, Never>?
    // Raw counters, copied into `stats` by the poll so SwiftUI is not redrawn per frame.
    private var seq: UInt32 = 0
    private var sent = 0, received = 0, lost = 0
    private var nextSeq: UInt32?
    private var rtts: [Double] = []
    private var startedAt = ContinuousClock.now
    private var lastSocketMs = 0, lastReadyMs = 0
    private var lastMediaNodeId: String?
    // Downlink frames that arrive before the session is active (no engine yet): played once the engine starts.
    private var early: [(pcm: Data, missing: Int)] = []
    /// S112: codec offered in hello. "pcm16k" is the rollback switch.
    static var preferredCodec = "opus16k"
    // S112: codec the bridge confirmed for the current socket; codec objects are rebuilt per connect (fresh state).
    private var codec = "pcm16k"
    private var encoder: WatchOpusEncoder?
    private var decoder: WatchOpusDecoder?
    private var opusRefused = false // this call's bridge answered ready without opus16k: offer pcm16k from now on
    private var bytesUp = 0, bytesDown = 0, encodeErrors = 0, decodeErrors = 0
    /// S105d: every `.connected` (first start, CallKit retry, reconnect after socket loss).
    var onConnected: (@MainActor () -> Void)?
    /// S105k: the store's current access token, read before every socket open (the one passed to `start` expires
    /// mid-call; reconnects with it got 4401).
    var currentToken: (@MainActor () -> String?)?

    init() {}

    /// Opens the TLS WebSocket ahead of `start` (watch-only Wi-Fi took 8 s to open) and leaves it idle — no hello.
    /// No-op while a leg is live or a prewarmed socket is still opening/open. Waits for the open (bounded by
    /// `readyTimeout`, like `handshake`); returns true when it failed with a retryable "network not up yet" error
    /// (S105d: right after CallKit accepted a start, watchOS still answered -1009).
    func prewarm(callId: String, token: String, attempt: Int) async -> Bool {
        guard !live else { return false }
        if let p = prewarmed {
            if p.task.state == .running { return false }
            p.task.cancel(with: .normalClosure, reason: nil)
        }
        let task = Self.openSocket(token: token)
        prewarmed = (task, token)
        let timeout = Task { @MainActor in
            try? await Task.sleep(for: readyTimeout)
            if !Task.isCancelled { task.cancel(with: .goingAway, reason: nil) } // fires the ping callback with an error
        }
        // A WebSocket ping completes once the socket is open (or failed): that is the prewarm time.
        let started = ContinuousClock.now
        let error: (any Error)? = await withCheckedContinuation { continuation in
            task.sendPing { @Sendable error in continuation.resume(returning: error) }
        }
        timeout.cancel()
        var f: [String: DiagValue] = error.map { WatchDiag.error($0) } ?? [:]
        f["ms"] = .int(started.msSince)
        f["ok"] = .bool(error == nil)
        f["attempt"] = .int(attempt)
        WatchDiag.log("watch.leg.prewarm", level: error == nil ? "info" : "warn", callId: callId, f)
        guard let code = (error as? URLError)?.code, !live, prewarmed?.task === task else { return false }
        return code == .notConnectedToInternet || code == .networkConnectionLost
    }

    func start(callId: String, token: String, frameMs: Int = 40) async throws {
        guard !live else { return }
        self.callId = callId; self.token = token; self.frameMs = frameMs == 20 ? 20 : 40
        live = true; reconnecting = false; manuallyActivated = false
        seq = 0; sent = 0; received = 0; lost = 0; nextSeq = nil; rtts = []; early = []
        bytesUp = 0; bytesDown = 0; encodeErrors = 0; decodeErrors = 0; opusRefused = false
        startedAt = .now
        stats.state = .connecting
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .voiceChat) // voiceChat implies allowBluetoothHFP
        do {
            try await connect()
        } catch {
            WatchDiag.log("watch.leg.start", level: "warn", callId: callId, WatchDiag.error(error, ["socketMs": .int(lastSocketMs)]))
            // Stopped meanwhile (call ended mid-handshake): leave `.stopped`, do not report a failure.
            if live {
                await stop()
                fail(error.localizedDescription)
            }
            throw error
        }
        guard live else { return }
        var fields: [String: DiagValue] = ["socketMs": .int(lastSocketMs), "readyMs": .int(lastReadyMs), "codec": .string(codec)]
        if let lastMediaNodeId { fields["mediaNodeId"] = .string(lastMediaNodeId) }
        WatchDiag.log("watch.leg.start", callId: callId, fields)
        markConnected()
        tasks.append(Task { @MainActor [weak self] in
            // CallKit normally hands us the session via didActivate; if not within 3 s, activate it ourselves.
            try? await Task.sleep(for: .seconds(3))
            guard let self, self.live, self.audio == nil else { return }
            do {
                try AVAudioSession.sharedInstance().setActive(true)
                self.manuallyActivated = true
                self.beginAudio()
            } catch { self.fail("音频会话激活失败：\(error.localizedDescription)") }
        })
        tasks.append(Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.refresh()
                try? await Task.sleep(for: .milliseconds(250))
            }
        })
        tasks.append(Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: pingInterval)
                self?.sendPing()
                self?.checkStall()
            }
        })
        tasks.append(Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard let self, self.live, !Task.isCancelled else { return }
                self.logStats()
            }
        })
        tasks.append(Task { @MainActor [weak self] in
            for await _ in NotificationCenter.default.notifications(named: AVAudioSession.routeChangeNotification) {
                self?.applyRoute()
            }
        })
        tasks.append(Task { @MainActor [weak self] in
            // A route/format change (e.g. AirPods attach mid-call) stops AVAudioEngine; rebuild for the new input format.
            for await _ in NotificationCenter.default.notifications(named: .AVAudioEngineConfigurationChange) {
                guard let self, let audio = self.audio, !audio.isRunning else { continue }
                audio.stop()
                self.audio = nil
                self.beginAudio()
            }
        })
    }

    private func fail(_ reason: String) {
        stats.state = .failed(reason)
        WatchDiag.log("watch.leg.failed", level: "error", callId: callId, ["reason": .string(reason)])
    }

    private func logStats() {
        refresh()
        var f: [String: DiagValue] = [
            "sent": .int(stats.sent), "received": .int(stats.received), "lost": .int(stats.lost),
            "underruns": .int(stats.underruns), "restarts": .int(stats.restarts), "bufferMs": .int(stats.bufferMs), "tails": .int(stats.tails),
            "inputLevelDb": .double(stats.inputLevelDb), "route": .string("\(stats.route)"), "state": .string("\(stats.state)"),
            "gain": .double(Double(WatchAudioEngine.downlinkGain)),
            "codec": .string(codec), "bytesUp": .int(bytesUp), "bytesDown": .int(bytesDown),
            "encodeErrors": .int(encodeErrors), "decodeErrors": .int(decodeErrors),
        ]
        if let p = stats.rttP50Ms { f["rttP50"] = .double(p) }
        if let p = stats.rttP95Ms { f["rttP95"] = .double(p) }
        WatchDiag.log("watch.leg.stats", callId: callId, f)
    }

    private func markConnected() {
        if case .failed = stats.state { return }
        stats.state = .connected
        onConnected?()
    }

    func audioSessionDidActivate(_ session: AVAudioSession) {
        beginAudio()
    }

    func audioSessionDidDeactivate(_ session: AVAudioSession) {
        audio?.stop()
        audio = nil
        early = []
    }

    func stop() async {
        prewarmed?.task.cancel(with: .normalClosure, reason: nil)
        prewarmed = nil
        guard live else {
            // A CallKit start retry may have shown `.reconnecting` between attempts: a stopped leg never keeps it.
            if case .reconnecting = stats.state { stats.state = .stopped }
            return
        }
        live = false
        tasks.forEach { $0.cancel() }
        tasks = []
        // Socket stays open through the fade so the uplink's ramp to zero reaches the bridge; inbound frames are
        // dropped meanwhile (`handle` with no engine and `!live`).
        let oldSocket = socket
        early = []
        refresh()
        if let audio {
            // Detach first: during the fade await, didDeactivate / a new start must not see or clobber this engine.
            self.audio = nil
            let snap = audio.snapshot
            let stopMs = await audio.fadeOut() // before engine.stop(), so before the session deactivates below
            audio.stop()
            var f: [String: DiagValue] = [:]
            if let ms = snap.firstPlayMs { f["startMs"] = .int(ms) }
            if let stopMs { f["stopMs"] = .int(stopMs) }
            if let ms = snap.prerollMs { f["prerollMs"] = .int(ms) }
            if !f.isEmpty { WatchDiag.log("watch.leg.fade", callId: callId, f) }
        }
        if socket === oldSocket { closeSocket() } else { oldSocket?.cancel(with: .normalClosure, reason: nil) }
        if live { return } // a new start() began during the fade: it owns the socket, session and state now
        // Under CallKit the system deactivates the session; only undo our own manual activation.
        if manuallyActivated {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            manuallyActivated = false
        }
        if case .failed = stats.state {} else { stats.state = .stopped }
    }

    func setMuted(_ muted: Bool) {
        self.muted = muted
        audio?.setMuted(muted)
    }

    /// Only reports the live route: watchOS offers no API to force built-in vs Bluetooth output (see applyRoute).
    func route(_ route: WatchAudioRoute) {
        applyRoute()
    }

    // MARK: Audio

    private func beginAudio() {
        guard live, audio == nil else { return }
        let audio = WatchAudioEngine(frameMs: frameMs)
        audio.setMuted(muted)
        self.audio = audio
        do {
            try audio.start { @Sendable [weak self] frame in Task { @MainActor in self?.send(frame) } }
            WatchDiag.log("watch.leg.engine", callId: callId, ["aec": .string(audio.aec), "inputHz": .int(Int(audio.inputSampleRate))])
        } catch {
            self.audio = nil
            fail("音频引擎：\(error.localizedDescription)")
            return
        }
        for f in early { audio.play(f.pcm, missing: f.missing) }
        early = []
        applyRoute()
    }

    /// Bluetooth output connected → it carries audio (category allows HFP); otherwise the built-in speaker.
    /// watchOS has no speaker/receiver override (`PortOverride.speaker` and `defaultToSpeaker` are unavailable):
    /// the watch has one built-in speaker, so `.earpiece` and `.speaker` both mean "built-in" here.
    private func applyRoute() {
        let btTypes: Set<AVAudioSession.Port> = [.bluetoothHFP, .bluetoothA2DP, .bluetoothLE]
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        let actual: WatchAudioRoute = outputs.contains { btTypes.contains($0.portType) } ? .bluetooth : .speaker
        if stats.route != actual { stats.route = actual }
    }

    // MARK: WebSocket

    /// Opens a socket, sends hello at once, waits (bounded) for ready. Throws on error reply, socket error or timeout.
    private func connect() async throws {
        if let fresh = currentToken?(), !fresh.isEmpty { token = fresh }
        // Reuse a prewarmed socket (same token, still alive); if it turns out dead, fall back to a fresh one once.
        if let p = prewarmed {
            prewarmed = nil
            if p.token == token, p.task.state == .running {
                do { try await negotiate(p.task); return } catch where live && !(error is WatchAudioLegError) {}
            } else {
                p.task.cancel(with: .normalClosure, reason: nil)
            }
        }
        try await negotiate(Self.openSocket(token: token))
    }

    /// S112: offers opus16k when preferred and both converters build; a bridge whose ready lacks `codec: opus16k`
    /// (pre-S112) would read Opus as PCM, so that socket is dropped and one fresh pcm16k socket replaces it.
    private func negotiate(_ task: URLSessionWebSocketTask) async throws {
        if try await handshake(task, offer: makeOpus() ? "opus16k" : "pcm16k") { return }
        opusRefused = true
        WatchDiag.log("watch.leg.codec_fallback", level: "warn", callId: callId, ["reason": .string("bridge_no_opus")])
        _ = try await handshake(Self.openSocket(token: token), offer: "pcm16k")
    }

    /// Fresh encoder + decoder for this socket; false (objects cleared) when not preferred, refused or unavailable.
    private func makeOpus() -> Bool {
        encoder = nil; decoder = nil
        guard Self.preferredCodec == "opus16k", !opusRefused else { return false }
        let enc = WatchOpusEncoder(frameMs: frameMs)
        let dec = enc.outputFormat.map { WatchOpusDecoder(input: $0, magicCookie: enc.magicCookie, frameMs: frameMs) }
        guard enc.ok, let dec, dec.ok else {
            WatchDiag.log("watch.leg.codec_fallback", level: "warn", callId: callId, [
                "reason": .string("converter"), "encoder": .string(enc.inputFormatAccepted), "decoder": .string(dec?.note ?? "未创建"),
            ])
            return false
        }
        encoder = enc; decoder = dec
        return true
    }

    private static func openSocket(token: String) -> URLSessionWebSocketTask {
        var request = URLRequest(url: watchAudioURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = URLSession.shared.webSocketTask(with: request)
        task.resume()
        return task
    }

    /// Returns false (socket closed) only when opus16k was offered and the bridge did not confirm it.
    private func handshake(_ task: URLSessionWebSocketTask, offer: String) async throws -> Bool {
        socket = task
        socketReady = false
        nextSeq = nil
        codec = "pcm16k"
        lastSocketMs = 0; lastReadyMs = 0; lastMediaNodeId = nil
        let began = ContinuousClock.now
        let timeout = Task { @MainActor in
            try? await Task.sleep(for: readyTimeout)
            if !Task.isCancelled { task.cancel(with: .goingAway, reason: nil) }
        }
        defer { timeout.cancel() }
        let hello: [String: Any] = [
            "type": "hello", "callId": callId, "codec": offer, "frameMs": frameMs,
            "deviceName": WKInterfaceDevice.current().name,
        ]
        let helloText = String(decoding: try JSONSerialization.data(withJSONObject: hello), as: UTF8.self)
        do {
            try await task.send(.string(helloText))
            lastSocketMs = began.msSince // hello written = socket open
            while true {
                guard case .string(let text) = try await task.receive(), let json = Self.json(text) else { continue }
                let type = json["type"] as? String
                if type == "ready" || type == "echo" { // echo = spike echo server (testing)
                    lastReadyMs = began.msSince
                    lastMediaNodeId = json["mediaNodeId"] as? String
                    codec = json["codec"] as? String ?? "pcm16k"
                    break
                }
                if type == "error" { throw WatchAudioLegError(message: "音频桥拒绝：\(json["code"] as? String ?? "unknown")") }
            }
        } catch {
            task.cancel(with: .goingAway, reason: nil)
            if socket === task { socket = nil }
            throw error
        }
        guard live, socket === task else { task.cancel(with: .normalClosure, reason: nil); return true }
        if offer == "opus16k", codec != "opus16k" {
            task.cancel(with: .normalClosure, reason: nil)
            socket = nil
            codec = "pcm16k"
            return false
        }
        if codec != "opus16k" { encoder = nil; decoder = nil }
        socketReady = true
        lastInboundNs = monotonicNs()
        receiveTask = Task { @MainActor [weak self] in
            while true {
                do {
                    let message = try await task.receive()
                    guard let self, self.socket === task else { return }
                    switch message {
                    case .data(let data): self.handle(data)
                    case .string(let text): self.handleText(text)
                    @unknown default: break
                    }
                } catch {
                    guard let self, self.socket === task else { return }
                    self.socketLost(error)
                    return
                }
            }
        }
        return true
    }

    private func closeSocket() {
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        socketReady = false
    }

    private func socketLost(_ error: Error) {
        guard live, !reconnecting else { return }
        var f = WatchDiag.error(error, ["attempt": 0])
        if let code = socket?.closeCode, code != .invalid { f["code"] = .int(code.rawValue) }
        WatchDiag.log("watch.leg.socket_lost", level: "warn", callId: callId, f)
        closeSocket()
        // S105i: the iPhone's leg replaced ours → release the call instead of taking the bridge leg back.
        if WatchCallKit.shared.releaseIfPhoneHolds(callId) { return }
        reconnecting = true
        tasks.append(Task { @MainActor [weak self] in
            for attempt in 0..<reconnectMaxAttempts {
                let delay = reconnectDelays[min(attempt, reconnectDelays.count - 1)]
                // `stop()` cancels this task and clears `live`: every step re-checks, so a stopped leg never
                // shows `.reconnecting` again.
                guard let self, self.live, !Task.isCancelled else { return }
                if WatchCallKit.shared.releaseIfPhoneHolds(self.callId) { self.reconnecting = false; return }
                self.stats.state = .reconnecting(attempt: attempt + 1)
                try? await Task.sleep(for: delay)
                guard self.live, !Task.isCancelled else { return }
                if WatchCallKit.shared.releaseIfPhoneHolds(self.callId) { self.reconnecting = false; return }
                do {
                    try await self.connect()
                    self.reconnecting = false
                    if self.live { self.markConnected() }
                    return
                } catch {
                    WatchDiag.log("watch.leg.socket_lost", level: "warn", callId: self.callId,
                                  WatchDiag.error(error, ["attempt": .int(attempt + 1)]))
                }
            }
            guard let self, self.live else { return }
            self.reconnecting = false
            self.fail("音频中断")
        })
    }

    private func send(_ frame: Data) {
        guard let socket, socketReady else { return }
        var frame = frame
        if codec == "opus16k" {
            // nil = converter error or a held (priming) frame: never send PCM into an opus session.
            guard let packet = encoder?.encode(frame) else { if encoder?.lastStatus != 0 { encodeErrors += 1 }; return } // nil with status 0 = priming, not an error
            frame = packet
        }
        seq &+= 1
        bytesUp += frame.count
        var data = Data(capacity: headerBytes + frame.count)
        withUnsafeBytes(of: seq.bigEndian) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: monotonicNs().bigEndian) { data.append(contentsOf: $0) }
        data.append(frame)
        sent += 1
        socket.send(.data(data)) { @Sendable [weak self] err in
            guard let err else { return }
            Task { @MainActor in if let self, self.socket === socket { self.socketLost(err) } }
        }
    }

    /// S105k: the iPhone handed over a new access token while the leg is up: re-auth the open socket in place
    /// (bridge answers `token_ok`, ignored). Not connected → the next `connect()` reads it via `currentToken`.
    func rotateToken(_ newToken: String) {
        guard live, newToken != token else { return }
        token = newToken
        let sent = socketReady && socket != nil
        if sent, let socket, let data = try? JSONSerialization.data(withJSONObject: ["type": "token", "token": newToken]) {
            socket.send(.string(String(decoding: data, as: UTF8.self))) { @Sendable _ in }
        }
        WatchDiag.log("watch.leg.token_rotated", callId: callId, ["sent": .bool(sent)])
    }

    private func sendPing() {
        guard let socket, socketReady else { return }
        socket.send(.string(#"{"type":"ping","t":\#(monotonicNs())}"#)) { @Sendable _ in }
    }

    /// S108: last inbound of any kind (frame or pong); reset when a socket becomes ready.
    private var lastInboundNs: UInt64 = 0
    private func checkStall() {
        guard socketReady, !reconnecting, lastInboundNs > 0 else { return }
        let silentMs = Int((monotonicNs() - lastInboundNs) / 1_000_000)
        guard silentMs >= Int(stallTimeout.components.seconds) * 1000 else { return }
        WatchDiag.log("watch.leg.stalled", level: "warn", callId: callId, ["silentMs": .int(silentMs), "received": .int(received), "sent": .int(sent)])
        socketLost(WatchAudioLegError(message: "\(silentMs / 1000) s 无响应"))
    }

    private func handle(_ data: Data) {
        guard data.count > headerBytes else { return }
        let frameSeq = data.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        received += 1
        lastInboundNs = monotonicNs()
        if received == 1 {
            WatchDiag.log("watch.leg.first_down_frame", callId: callId, ["msSinceStart": .int(startedAt.msSince)])
        }
        var gap = 0
        if let expected = nextSeq, frameSeq > expected { gap = Int(min(frameSeq - expected, 1000)); lost += gap }
        if nextSeq.map({ frameSeq >= $0 }) ?? true { nextSeq = frameSeq &+ 1 }
        var pcm = Data(data.dropFirst(headerBytes))
        bytesDown += pcm.count
        if codec == "opus16k" {
            let frameBytes = frameMs * 32
            if let out = decoder?.decode(pcm) {
                // Priming: the first output may be short → leading zeros to a full frame; longer → trim.
                pcm = out.count < frameBytes ? Data(count: frameBytes - out.count) + out : out.prefix(frameBytes)
            } else {
                decodeErrors += 1
                pcm = Data(count: frameBytes) // same silence a missing frame gets
            }
        }
        if let audio {
            audio.play(pcm, missing: gap)
        } else if live {
            early.append((pcm, gap))
            let cap = 200 / frameMs // same ceiling as the jitter buffer
            if early.count > cap { early.removeFirst(early.count - cap) }
        }
    }

    /// `pong` from the bridge carries our `t`; the spike echo server nests our text under `received`.
    private func handleText(_ text: String) {
        guard let json = Self.json(text) else { return }
        var t: UInt64?
        switch json["type"] as? String {
        case "pong": t = (json["t"] as? NSNumber)?.uint64Value; lastInboundNs = monotonicNs()
        case "echo": t = (json["received"] as? String).flatMap(Self.json).flatMap { ($0["t"] as? NSNumber)?.uint64Value }
        case "error": socketLost(WatchAudioLegError(message: json["code"] as? String ?? "error"))
        default: break
        }
        guard let t, t > 0, t <= monotonicNs() else { return }
        rtts.append(Double(monotonicNs() - t) / 1e6)
        if rtts.count > 30 { rtts.removeFirst(rtts.count - 30) }
    }

    private func refresh() {
        if let snap = audio?.snapshot {
            stats.inputLevelDb = Double(snap.levelDb)
            stats.underruns = snap.underruns
            stats.restarts = snap.restarts
            stats.tails = snap.tails
            stats.bufferMs = snap.depthMs
        }
        stats.sent = sent; stats.received = received; stats.lost = lost
        let sorted = rtts.sorted()
        stats.rttP50Ms = sorted.isEmpty ? nil : sorted[sorted.count / 2]
        stats.rttP95Ms = sorted.isEmpty ? nil : sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
    }

    private static func json(_ text: String) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
    }
}

