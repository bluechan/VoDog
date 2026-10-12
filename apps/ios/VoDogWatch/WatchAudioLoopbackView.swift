import AVFAudio
import CallKit
import SwiftUI

// S105 spike: prove on a real watch that (1) mic + speaker run together under a CallKit call, (2) a WebSocket opens
// during that call (TN3135), (3) 16 kHz PCM16 survives the watch's network path. The simulator enforces none of this.
// Stage 3 repeats stage 2 with no CallKit call at all (self-activated `.voiceChat` session) and records scene-phase
// intervals, to see whether watchOS lets the socket open and keeps audio + frames flowing with the wrist down.
// Server side is the real audio bridge in loopback mode: `hello` with `callId:"loopback"` + Bearer token → `ready`, then
// binary frames are echoed verbatim. Frames sent before `ready` are dropped by the bridge, so we hold them until then.

private let loopbackURL = watchAudioURL
private let frameSamples = 320 // 20 ms at 16 kHz
private let prebufferFrames = 5 // ~100 ms before playback starts / restarts after an underrun

private func uptimeNs() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

/// Audio-thread side: mic → 16 kHz Int16 mono 20 ms frames; frames → player. Never touches the main actor.
final class LoopbackAudio: @unchecked Sendable {
    struct Stats: Sendable { var levelDB: Float = -160; var captured = 0; var played = 0; var underruns = 0 }
    /// S106 spike: ways of enabling Apple's voice-processing I/O (AEC). Variant A (= TestFlight 104) started the
    /// engine on a real watch but never rendered or captured; B and C change the order and the tap format.
    enum AEC: String, CaseIterable, Sendable {
        case off, a, b, c
        var label: String {
            switch self {
            case .off: "关"
            case .a: "A 接线前启用"
            case .b: "B 先碰输出，tap 自动格式"
            case .c: "C prepare 后启用"
            }
        }
    }
    let aec: AEC
    /// What actually happened: "variant · enabled? · input Hz" or the thrown error, for the page and the diag.
    private(set) var aecNote = "关"

    init(aec: AEC = .off) { self.aec = aec }

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
    private let pcm16 = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private var converter: AVAudioConverter? // tap thread only
    private var pending: [Int16] = [] // tap thread only
    private let lock = NSLock()
    private var stats = Stats()
    private var prebuffer: [Data] = []
    private var queued = 0
    private var playing = false
    private var running = false

    var snapshot: Stats { lock.withLock { stats } }

    /// Call after the audio session is active (the input format is 0 Hz before). `onFrame` runs on the tap thread.
    func start(onFrame: @escaping @Sendable (Data) -> Void) throws {
        let input = engine.inputNode
        var enableError: String?
        func enable() { do { try input.setVoiceProcessingEnabled(true) } catch { enableError = error.localizedDescription } }
        if aec == .b { _ = engine.outputNode; _ = engine.mainMixerNode } // create the output chain first, then switch I/O
        if aec == .a || aec == .b { enable() }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        if aec == .c { engine.prepare(); enable() }
        let hw = input.outputFormat(forBus: 0)
        guard hw.sampleRate > 0, let conv = AVAudioConverter(from: hw, to: pcm16) else {
            throw NSError(domain: "Loopback", code: 1, userInfo: [NSLocalizedDescriptionKey: "无麦克风输入格式（\(hw.sampleRate) Hz）"])
        }
        converter = conv
        // B and C: `nil` lets the tap take the node's own (post-voice-processing) format instead of a pinned one.
        input.installTap(onBus: 0, bufferSize: 1024, format: aec == .a || aec == .off ? hw : nil) { @Sendable [weak self] buffer, _ in
            self?.capture(buffer, onFrame: onFrame)
        }
        lock.withLock { running = true }
        engine.prepare()
        try engine.start()
        aecNote = aec == .off ? "关" : "\(aec.rawValue.uppercased()) · \(input.isVoiceProcessingEnabled ? "on" : "off") · \(Int(input.outputFormat(forBus: 0).sampleRate)) Hz" + (enableError.map { " · \($0)" } ?? "")
    }

    func stop() {
        let wasRunning = lock.withLock { let r = running; running = false; return r }
        guard wasRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
    }

    private func capture(_ buffer: AVAudioPCMBuffer, onFrame: (Data) -> Void) {
        let level = Self.rmsDB(buffer)
        if let c = converter, c.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: pcm16) }
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
        var frames: [Data] = []
        if let ch = out.int16ChannelData, out.frameLength > 0 {
            pending.append(contentsOf: UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
            while pending.count >= frameSamples {
                frames.append(pending[0..<frameSamples].withUnsafeBytes { Data($0) })
                pending.removeFirst(frameSamples)
            }
        }
        lock.withLock { stats.levelDB = level; stats.captured += frames.count }
        frames.forEach(onFrame)
    }

    /// Thread-safe. `pcm` is 640 bytes of 16 kHz Int16 mono. Jitter buffer: hold `prebufferFrames` before (re)starting.
    func play(_ pcm: Data) {
        let batch: [Data] = lock.withLock {
            guard running else { return [] }
            prebuffer.append(pcm)
            if !playing && prebuffer.count < prebufferFrames { return [] }
            playing = true
            let out = prebuffer
            prebuffer = []
            queued += out.count
            return out
        }
        guard !batch.isEmpty else { return }
        batch.forEach(schedule)
        if !player.isPlaying { player.play() }
    }

    private func schedule(_ pcm: Data) {
        let n = pcm.count / 2
        guard let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(n)), let dst = buf.floatChannelData?[0] else { return }
        buf.frameLength = AVAudioFrameCount(n)
        pcm.withUnsafeBytes { raw in
            for i in 0..<n { dst[i] = Float(raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)) / 32768 }
        }
        player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { @Sendable [weak self] _ in self?.didPlay() }
    }

    private func didPlay() {
        lock.withLock {
            guard running else { return }
            stats.played += 1
            queued -= 1
            if queued == 0 && playing { stats.underruns += 1; playing = false }
        }
    }

    private static func rmsDB(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return -160 }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += ch[i] * ch[i] }
        return max(-160, 10 * log10(sum / Float(buffer.frameLength) + 1e-16))
    }
}

/// S112 spike, local stage only: 20 ms mic frames → Opus encode → decode → `play`. 40 ms accumulates two frames.
/// A failed packet is dropped (an audible gap is honest evidence); the counters say why.
final class LoopbackOpus: @unchecked Sendable {
    enum Codec: String, CaseIterable, Sendable {
        case pcm, opus20, opus40
        var label: String { switch self { case .pcm: "PCM"; case .opus20: "Opus 20 ms"; case .opus40: "Opus 40 ms" } }
        var frameMs: Int { self == .opus40 ? 40 : 20 }
    }
    struct Stats: Sendable {
        var frameMs = 20, packets = 0, bytes = 0, held = 0, encodeErrors = 0, decodeErrors = 0, decodedFrames = 0
        var kbps: Double { packets > 0 ? Double(bytes * 8) / Double(packets * frameMs) : 0 } // bytes·8 / audio seconds
    }

    let codec: Codec
    let encoder: WatchOpusEncoder
    let decoder: WatchOpusDecoder?
    var ok: Bool { encoder.ok && decoder?.ok == true }
    private let lock = NSLock()
    private var pending = Data()
    private var stats = Stats()

    init(_ codec: Codec) {
        self.codec = codec
        stats.frameMs = codec.frameMs
        let encoder = WatchOpusEncoder(frameMs: codec.frameMs)
        self.encoder = encoder
        decoder = encoder.outputFormat.map { WatchOpusDecoder(input: $0, magicCookie: encoder.magicCookie, frameMs: codec.frameMs) }
    }

    /// "Opus 20 ms · 编码 ok · 解码 ok · 16000 Hz/320 ok · …" for the 「编码」 row.
    var note: String {
        let enc = encoder.ok ? "编码 ok" : "编码 err"
        let dec = decoder.map { $0.ok ? "解码 \($0.note)" : "解码 err \($0.note)" } ?? "解码 未创建"
        return "\(codec.label) · \(enc) · \(dec) · \(encoder.inputFormatAccepted)" + (ok ? "" : " · 已退回 PCM")
    }

    var snapshot: Stats { lock.withLock { stats } }

    /// Tap thread. `frame` is 640 bytes (20 ms PCM16 16 kHz).
    func process(_ frame: Data, play: (Data) -> Void) {
        let chunk: Data? = lock.withLock {
            pending.append(frame)
            guard pending.count >= codec.frameMs * 32 else { return nil }
            defer { pending = Data() }
            return pending
        }
        guard let chunk, let decoder else { return }
        guard let packet = encoder.encode(chunk) else {
            let failed = encoder.lastStatus != noErr
            lock.withLock { if failed { stats.encodeErrors += 1 } else { stats.held += 1 } }
            return
        }
        let pcm = decoder.decode(packet)
        lock.withLock {
            stats.packets += 1
            stats.bytes += packet.count
            if let pcm { stats.decodedFrames += pcm.count / 2 } else { stats.decodeErrors += 1 }
        }
        guard let pcm else { return }
        var i = 0
        while i < pcm.count { play(pcm.subdata(in: i..<min(i + frameSamples * 2, pcm.count))); i += frameSamples * 2 }
    }
}

/// Main-actor side: CallKit fake call (stages 1–2), audio session, WebSocket, displayed numbers.
@MainActor @Observable
final class LoopbackController: NSObject {
    enum Stage { case local, server, direct } // direct = server loopback without CallKit

    struct Shown {
        var audio = LoopbackAudio.Stats()
        var sent = 0, received = 0, lost = 0
        var rttMs: Double?, p50Ms: Double?, p95Ms: Double?
        var opus = LoopbackOpus.Stats()
    }

    private struct PhaseMark { let phase: String; let at: Date; let sent: Int; let received: Int; let captured: Int; let played: Int }

    private(set) var stage: Stage?
    private(set) var running = false
    private(set) var status = "就绪"
    private(set) var error: String?
    private(set) var activation: String?
    private(set) var socketNote: String?
    private(set) var shown = Shown()
    private(set) var phaseLines: [String] = [] // one line per finished scene-phase interval
    private(set) var phaseNow: String?
    var aec: LoopbackAudio.AEC = .off
    private(set) var aecNote: String?
    var codec: LoopbackOpus.Codec = .pcm
    private(set) var opusNote: String?
    var network: LoopbackNetwork = .standard // S112d: server stages only
    private(set) var interface: String?
    private(set) var wifiOpenMs: Int?
    private(set) var wifiError: String?

    @ObservationIgnored private var provider: CXProvider? // created on first start: SwiftUI may build this view speculatively
    @ObservationIgnored private let callController = CXCallController()
    @ObservationIgnored private var callID: UUID?
    @ObservationIgnored private var audio: LoopbackAudio?
    @ObservationIgnored private var opusDecoder: WatchOpusDecoder? // set even when the encoder half failed
    @ObservationIgnored private var opus: LoopbackOpus? // local stage + Opus selected + both converters created; kept after stop for the summary
    @ObservationIgnored private var socket: (any LoopbackSocket)?
    @ObservationIgnored private var socketReady = false
    @ObservationIgnored private var socketFailed = false // first socket error wins; in-flight send completions repeat it
    @ObservationIgnored private var socketMs: Int?
    @ObservationIgnored private var readyMs: Int?
    @ObservationIgnored private var callActiveNs: UInt64 = 0
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var phaseMark: PhaseMark?
    // Raw network counters (copied into `shown` by the poll so SwiftUI is not redrawn 100×/s).
    @ObservationIgnored private var seq: UInt32 = 0
    @ObservationIgnored private var sent = 0
    @ObservationIgnored private var received = 0
    @ObservationIgnored private var lost = 0
    @ObservationIgnored private var nextSeq: UInt32 = 1
    @ObservationIgnored private var rtts: [Double] = []

    private var stageName: String {
        switch stage { case .local: "local"; case .server: "server"; case .direct: "direct"; case nil: "none" }
    }

    func start(_ stage: Stage) async {
        guard !running else { return }
        if stage != .direct, provider == nil {
            let config = CXProviderConfiguration()
            config.supportsVideo = false
            config.maximumCallsPerCallGroup = 1
            config.supportedHandleTypes = [.generic]
            config.includesCallsInRecents = false
            let provider = CXProvider(configuration: config)
            provider.setDelegate(self, queue: .main)
            self.provider = provider
        }
        self.stage = stage
        running = true
        error = nil; activation = nil; socketNote = nil; shown = Shown(); phaseLines = []; opusNote = nil; opus = nil; opusDecoder = nil
        seq = 0; sent = 0; received = 0; lost = 0; nextSeq = 1; rtts = []; socketMs = nil; readyMs = nil; socketFailed = false
        interface = nil; wifiOpenMs = nil; wifiError = nil
        mark("active")
        status = "请求麦克风权限…"
        guard await AVAudioApplication.requestRecordPermission() else { fail("麦克风权限被拒绝"); return }
        guard running else { return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat)
        } catch { fail("音频会话：\(Self.describe(error))"); return }
        if stage == .direct {
            status = "激活音频会话（无 CallKit）…"
            do {
                try AVAudioSession.sharedInstance().setActive(true)
            } catch { fail("激活音频会话失败（无 CallKit）：\(Self.describe(error))"); return }
            beginAudio("手动激活（无 CallKit）")
            return
        }
        let id = UUID()
        callID = id
        status = "发起 CallKit 通话…"
        let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: "loopback"))
        callController.request(CXTransaction(action: action)) { @Sendable err in
            guard let err else { return }
            Task { @MainActor in self.fail("CallKit 请求失败：\(Self.describe(err))") }
        }
        // Spike data point: if CallKit never hands us an active session, activate it ourselves and say so.
        try? await Task.sleep(for: .seconds(3))
        guard running, callID == id, audio == nil else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            beginAudio("3 秒未收到 didActivate，已手动激活")
        } catch { fail("手动激活音频会话失败：\(Self.describe(error))") }
    }

    func stop() {
        guard running else { return }
        running = false
        if let id = callID {
            callController.request(CXTransaction(action: CXEndCallAction(call: id))) { @Sendable _ in }
        }
        callID = nil
        mark(nil)
        teardown()
        if error == nil { status = "已停止" }
        do { // S106: the local stage is the AEC test bed; log it too.
            var f: [String: DiagValue] = ["stage": .string(stageName), "aec": .string(aecNote ?? aec.rawValue), "sent": .int(sent), "received": .int(received),
                                          "lost": .int(lost), "captured": .int(shown.audio.captured),
                                          "played": .int(shown.audio.played), "underruns": .int(shown.audio.underruns)]
            if let socketMs { f["socketMs"] = .int(socketMs) }
            if let readyMs { f["readyMs"] = .int(readyMs) }
            if let p50 = shown.p50Ms { f["rttP50Ms"] = .double(p50) }
            if let p95 = shown.p95Ms { f["rttP95Ms"] = .double(p95) }
            if let error { f["error"] = .string(String(error.prefix(160))) }
            if stage != .local { // S112d
                f["network"] = .string(network.rawValue)
                f["interface"] = .string(interface ?? "unknown")
                if let wifiOpenMs { f["wifiOpenMs"] = .int(wifiOpenMs) }
                if let wifiError { f["wifiError"] = .string(String(wifiError.prefix(160))) }
            }
            if stage == .local, opusNote != nil { // S112
                let o = shown.opus
                f["opus"] = .string(opus == nil ? "\(codec.rawValue)-fallback-pcm" : codec.rawValue)
                f["opusPackets"] = .int(o.packets)
                f["opusMeanBytes"] = .double(o.packets > 0 ? Double(o.bytes) / Double(o.packets) : 0)
                f["opusKbps"] = .double(o.kbps)
                f["opusDecodeErrors"] = .int(o.decodeErrors)
                f["opusEncodeErrors"] = .int(o.encodeErrors)
                f["opusHeld"] = .int(o.held)
                f["opusEncoderStatus"] = .string(String((opusNote ?? "").prefix(300)) + " · last \(osStatusText(opus?.encoder.lastStatus ?? 0))")
                f["opusDecoderStatus"] = .string(opusDecoder.map { "\($0.note) · last \(osStatusText($0.lastStatus))" } ?? "未创建")
            }
            WatchDiag.log("watch.spike.summary", level: error == nil ? "info" : "warn", f)
            Task { await WatchDiag.flush() }
        }
    }

    /// Leaving the page.
    func close() {
        stop()
        provider?.invalidate()
        provider = nil
    }

    /// 熄屏考验: called on every scene-phase change. Socket and engine keep running in the background on purpose.
    func phaseChanged(_ phase: ScenePhase) {
        guard running else { return }
        let name = switch phase { case .active: "active"; case .inactive: "inactive"; case .background: "background"; @unknown default: "unknown" }
        mark(name)
    }

    /// Closes the open interval (logging what flowed during it) and opens `phase`; `nil` only closes.
    private func mark(_ phase: String?) {
        let now = Date.now
        let a = audio?.snapshot ?? shown.audio
        if let m = phaseMark, m.phase != phase {
            let secs = now.timeIntervalSince(m.at)
            let d = (sent: sent - m.sent, received: received - m.received, captured: a.captured - m.captured, played: a.played - m.played)
            phaseLines.append(String(format: "%@ %@ %.1f s · 发 %d 收 %d · 采 %d 播 %d",
                                     m.at.formatted(.dateTime.hour().minute().second()), m.phase, secs,
                                     d.sent, d.received, d.captured, d.played))
            WatchDiag.log("watch.spike.phase", ["stage": .string(stageName), "phase": .string(m.phase), "ms": .int(Int(secs * 1000)),
                                                "sent": .int(d.sent), "received": .int(d.received),
                                                "captured": .int(d.captured), "played": .int(d.played)])
        } else if phaseMark?.phase == phase { return }
        phaseMark = phase.map { PhaseMark(phase: $0, at: now, sent: sent, received: received, captured: a.captured, played: a.played) }
        phaseNow = phase.map { "\($0) 自 \(now.formatted(.dateTime.hour().minute().second()))" }
    }

    private func fail(_ text: String) {
        error = text
        status = "失败"
        stop()
    }

    private func teardown() {
        audio?.stop()
        socket?.cancel()
        socket = nil
        socketReady = false
        poll?.cancel()
        poll = nil
        refresh()
        audio = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func beginAudio(_ how: String) {
        guard running, audio == nil else { return }
        activation = how
        callActiveNs = uptimeNs()
        let audio = LoopbackAudio(aec: aec)
        self.audio = audio
        defer { aecNote = audio.aecNote }
        do {
            if stage == .local {
                if codec != .pcm { // S112: a failed init keeps PCM running and says so on the page
                    let o = LoopbackOpus(codec)
                    opusNote = o.note
                    opusDecoder = o.decoder
                    opus = o.ok ? o : nil
                }
                if let opus {
                    try audio.start { @Sendable [audio, opus] frame in opus.process(frame) { audio.play($0) } }
                } else {
                    try audio.start { @Sendable [audio] frame in audio.play(frame) }
                }
                status = "本机回环中"
            } else {
                openSocket()
                try audio.start { @Sendable frame in Task { @MainActor in self.send(frame) } }
                status = stage == .direct ? "服务器回环中（无 CallKit）" : "服务器回环中"
            }
        } catch { fail("音频引擎：\(Self.describe(error))"); return }
        poll = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.refresh()
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    private func refresh() {
        let sorted = rtts.sorted()
        func pct(_ p: Double) -> Double? { sorted.isEmpty ? nil : sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))] }
        shown = Shown(
            audio: audio?.snapshot ?? shown.audio,
            sent: sent, received: received, lost: lost,
            rttMs: rtts.last, p50Ms: pct(0.5), p95Ms: pct(0.95),
            opus: opus?.snapshot ?? shown.opus
        )
    }

    // MARK: WebSocket (stages 1–2: opened only after the call is active; stage 3: after self-activation)

    private func openSocket() {
        let token = WatchSessionStore.shared.context?.session?.accessToken
        if token == nil { error = "未登录：没有访问令牌，音频桥会拒绝（先在 iPhone 上登录）" }
        let sock: any LoopbackSocket = network == .wifi ? NWLoopbackSocket(url: loopbackURL, token: token)
                                                        : URLSessionLoopbackSocket(url: loopbackURL, token: token)
        socket = sock
        let t0 = uptimeNs()
        let activeNs = callActiveNs
        socketNote = "连接中…"
        // Every event is dropped unless it comes from the socket currently installed (`===`).
        sock.open(LoopbackSocketEvents(
            opened: { [weak self, weak sock] ms, interface in
                guard let self, let sock, self.socket === sock else { return }
                self.wifiOpenMs = ms
                self.interface = interface
            },
            text: { [weak self, weak sock] text in
                guard let self, let sock, self.socket === sock else { return }
                self.handleText(text, t0: t0)
            },
            data: { [weak self, weak sock] data in
                guard let self, let sock, self.socket === sock else { return }
                self.handle(data)
            },
            failed: { [weak self, weak sock] err in
                guard let self, let sock, self.socket === sock else { return }
                self.netError(err, sock)
            }
        ))
        // The first send completes only after the handshake, so its completion time is the open latency.
        sock.sendText(#"{"type":"hello","codec":"pcm16k","frameMs":20,"callId":"loopback"}"#) { @Sendable err in
            let t1 = uptimeNs()
            Task { @MainActor in
                guard self.socket === sock else { return }
                if let err { self.netError(err, sock); return }
                let ms = Int((t1 - t0) / 1_000_000)
                self.socketMs = ms
                let order = t1 >= activeNs ? "激活之后" : "激活之前"
                self.socketNote = String(format: "已打开 %d ms · %@ +%.0f ms，等待 ready…", ms, order, Double(t1 &- activeNs) / 1e6)
                WatchDiag.log("watch.spike.socket_open", ["stage": .string(self.stageName), "socketMs": .int(ms)])
            }
        }
    }

    /// `ready` from the bridge (loopback mode) or `echo` from the old spike echo server opens the frame flow.
    private func handleText(_ text: String, t0: UInt64) {
        guard let json = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return }
        switch json["type"] as? String {
        case "ready", "echo":
            guard !socketReady else { return }
            socketReady = true
            let ms = Int((uptimeNs() - t0) / 1_000_000)
            readyMs = ms
            socketNote = "ready \(ms) ms（握手 \(socketMs.map { "\($0)" } ?? "?") ms）"
            WatchDiag.log("watch.spike.ready", ["stage": .string(stageName), "socketMs": .int(socketMs ?? -1), "readyMs": .int(ms)])
        case "error":
            error = "音频桥拒绝：\(json["code"] as? String ?? "unknown")"
            WatchDiag.log("watch.spike.bridge_error", level: "warn", ["stage": .string(stageName), "code": .string(json["code"] as? String ?? "unknown")])
        default: break // pong etc.
        }
    }

    private func send(_ frame: Data) {
        guard let socket, socketReady else { return }
        seq &+= 1
        var data = Data(capacity: 12 + frame.count)
        withUnsafeBytes(of: seq.bigEndian) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: uptimeNs().bigEndian) { data.append(contentsOf: $0) }
        data.append(frame)
        sent += 1
        socket.sendData(data) { @Sendable err in
            guard let err else { return }
            Task { @MainActor in if self.socket === socket { self.netError(err, socket) } }
        }
    }

    private func handle(_ data: Data) {
        guard data.count > 12 else { return }
        let bytes = [UInt8](data.prefix(12))
        let frameSeq = bytes[0..<4].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        let sentNs = bytes[4..<12].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        received += 1
        if frameSeq >= nextSeq {
            lost += Int(frameSeq - nextSeq)
            nextSeq = frameSeq + 1
        }
        rtts.append(Double(uptimeNs() &- sentNs) / 1e6)
        audio?.play(Data(data.dropFirst(12))) // play the echoed frame, never the local one
    }

    private func netError(_ error: Error, _ sock: any LoopbackSocket) {
        guard running, !socketFailed else { return }
        socketFailed = true
        socketReady = false
        let close = sock.closeCode.map { " · close \($0)" } ?? ""
        let text = "网络：\(Self.describe(error))\(close)"
        self.error = text
        if socketMs == nil { socketNote = "打开失败" }
        var f = WatchDiag.error(error, ["stage": .string(stageName), "sent": .int(sent), "received": .int(received)])
        if let code = sock.closeCode { f["closeCode"] = .int(code) }
        WatchDiag.log("watch.spike.socket_error", level: "warn", f)
        if sock is NWLoopbackSocket, wifiOpenMs == nil { // S112d spike: no fallback, the stage fails with the Wi-Fi error
            wifiError = Self.describe(error)
            fail(text)
        }
    }

    nonisolated private static func describe(_ error: Error) -> String {
        if let e = error as? LoopbackSocketError { return e.message }
        let ns = error as NSError
        var text = "\(ns.domain) \(ns.code) \(ns.localizedDescription)"
        if let under = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            text += " ← \(under.domain) \(under.code)"
            if under.domain == NSPOSIXErrorDomain, let name = POSIXErrorCode(rawValue: Int32(under.code)) { text += " (\(name))" }
        }
        return text
    }
}

extension LoopbackController: @preconcurrency CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        if running, stage != .direct { fail("CallKit 已重置") }
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        action.fulfill()
        provider.reportOutgoingCall(with: action.callUUID, connectedAt: nil)
        status = "通话已接通，等待音频会话…"
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        guard stage != .direct else { return }
        beginAudio("CallKit didActivate")
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}
}

// MARK: - Page

struct WatchAudioLoopbackView: View {
    @State private var controller = LoopbackController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let c = controller
        let s = c.shown
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(c.status).font(.system(size: 15, weight: .semibold)).foregroundStyle(Signal.ink)
                if c.running {
                    WideButton(title: "停止", symbol: "stop.fill", fill: Signal.dangerFill, ink: .white) { c.stop() }
                } else {
                    Picker("回声消除", selection: Bindable(controller).aec) {
                        ForEach(LoopbackAudio.AEC.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.navigationLink)
                    .font(.system(size: 15))
                    .frame(minHeight: 44)
                    Picker("编码", selection: Bindable(controller).codec) {
                        ForEach(LoopbackOpus.Codec.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.navigationLink)
                    .font(.system(size: 15))
                    .frame(minHeight: 44)
                    Picker("网络", selection: Bindable(controller).network) {
                        ForEach(LoopbackNetwork.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.navigationLink)
                    .font(.system(size: 15))
                    .frame(minHeight: 44)
                    WideButton(title: "本机回环", symbol: "mic.fill") { Task { await c.start(.local) } }
                    WideButton(title: "服务器回环", symbol: "network") { Task { await c.start(.server) } }
                    WideButton(title: "服务器回环（无 CallKit）", symbol: "antenna.radiowaves.left.and.right") { Task { await c.start(.direct) } }
                }
                if let error = c.error {
                    Text(error).font(.system(size: 13)).foregroundStyle(Signal.danger)
                }
                if c.stage != nil {
                    row("音频会话", c.activation ?? "等待中")
                    row("回声消除", c.aecNote ?? c.aec.label)
                    row("输入电平", String(format: "%.0f dB", s.audio.levelDB))
                    row("采集帧", "\(s.audio.captured)")
                    row("播放帧", "\(s.audio.played)")
                    row("欠载", "\(s.audio.underruns)")
                }
                if c.stage == .local, let note = c.opusNote { // S112
                    let o = s.opus
                    row("编码", note)
                    row("Opus 包", o.packets == 0 ? "0" : String(format: "%d · 均 %.1f B · %.1f kbps", o.packets, Double(o.bytes) / Double(o.packets), o.kbps))
                    row("解码失败", "\(o.decodeErrors)" + (o.encodeErrors > 0 ? " · 编码失败 \(o.encodeErrors)" : "") + (o.held > 0 ? " · 暂存 \(o.held)" : ""))
                }
                if let stage = c.stage, stage != .local {
                    row("网络", c.network == .wifi
                        ? "\(c.network.label) · 接口 \(c.interface ?? "—") · " + (c.wifiError ?? c.wifiOpenMs.map { "Wi-Fi 建连 \($0) ms" } ?? "Wi-Fi 建连中…")
                        : c.network.label)
                    row("WebSocket", c.socketNote ?? "未打开")
                    row("发送 / 收到", "\(s.sent) / \(s.received)")
                    row("丢失", "\(s.lost)")
                    row("往返", s.rttMs.map { String(format: "%.0f ms", $0) } ?? "—")
                    row("往返 p50 / p95", "\(s.p50Ms.map { String(format: "%.0f", $0) } ?? "—") / \(s.p95Ms.map { String(format: "%.0f ms", $0) } ?? "—")")
                }
                if c.stage != nil {
                    Text("熄屏考验").font(.system(size: 15, weight: .semibold)).foregroundStyle(Signal.ink).padding(.top, 4)
                    Text("放下手腕约 10 秒再抬起，看后台区间里帧是否还在走").font(.system(size: 12)).foregroundStyle(Signal.ink3)
                    if let now = c.phaseNow { row("当前", now) }
                    ForEach(Array(c.phaseLines.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.system(size: 12).monospacedDigit()).foregroundStyle(Signal.ink)
                    }
                }
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle("音频回环")
        .onChange(of: scenePhase) { _, phase in controller.phaseChanged(phase) }
        .onDisappear { controller.close() }
    }

    private func row(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 13)).foregroundStyle(Signal.ink3)
            Text(value).font(.system(size: 15).monospacedDigit()).foregroundStyle(Signal.ink)
        }
    }
}
