import AVFoundation
import WatchKit

/// S113b: dial-pad feedback. Haptic on every tap; a local DTMF tone only while no CallKit call is live — during a call
/// the shared AVAudioSession belongs to the call engine (WatchAudioLeg) and this class never touches it.
@MainActor
final class WatchKeyTone {
    static let shared = WatchKeyTone()

    private static let sampleRate = 16_000.0
    private static let rows: [Character: Double] = [
        "1": 697, "2": 697, "3": 697, "4": 770, "5": 770, "6": 770,
        "7": 852, "8": 852, "9": 852, "*": 941, "0": 941, "#": 941,
    ]
    private static let cols: [Character: Double] = [
        "1": 1209, "4": 1209, "7": 1209, "*": 1209,
        "2": 1336, "5": 1336, "8": 1336, "0": 1336,
        "3": 1477, "6": 1477, "9": 1477, "#": 1477,
    ]

    private let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var buffers: [Character: AVAudioPCMBuffer] = [:]
    private var sessionActive = false
    private var failed = false

    private init() {}

    func tap(_ key: String) {
        WKInterfaceDevice.current().play(.click)
        guard WatchCallKit.shared.current == nil else { return }
        guard !failed, let ch = key.first, let buffer = buffer(for: ch) else { return }
        do {
            if !sessionActive {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.ambient)
                try session.setActive(true)
                sessionActive = true
            }
            let player = try ensureEngine()
            player.scheduleBuffer(buffer, at: nil, options: .interrupts)
            if !player.isPlaying { player.play() }
        } catch {
            failed = true // haptic only from here on; logged once
            WatchDiag.log("watch.keytone", level: "warn", ["error": .string(String(describing: error))])
            teardownEngine()
        }
    }

    /// Dial page `onDisappear` / dial key: stop the engine and release the session so a following call starts clean.
    /// If a call is already live the session is the call's — the engine stops but the session is left alone.
    func stop() {
        teardownEngine()
        guard sessionActive else { return }
        sessionActive = false
        guard WatchCallKit.shared.current == nil else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func ensureEngine() throws -> AVAudioPlayerNode {
        if let engine, let player, engine.isRunning { return player }
        let engine = self.engine ?? AVAudioEngine()
        let player = self.player ?? AVAudioPlayerNode()
        if self.engine == nil {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            self.engine = engine
            self.player = player
        }
        try engine.start()
        return player
    }

    private func teardownEngine() {
        player?.stop()
        engine?.stop()
    }

    /// 90 ms, two sines at 0.25 each, 5 ms raised-cosine edges; built on first use, cached.
    private func buffer(for key: Character) -> AVAudioPCMBuffer? {
        if let cached = buffers[key] { return cached }
        guard let low = Self.rows[key], let high = Self.cols[key] else { return nil }
        let frames = Int(Self.sampleRate * 0.090)
        let fade = Int(Self.sampleRate * 0.005)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let out = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(frames)
        for i in 0..<frames {
            let t = Double(i) / Self.sampleRate
            var gain = 1.0
            let edge = min(i, frames - 1 - i)
            if edge < fade { gain = 0.5 - 0.5 * cos(Double.pi * Double(edge) / Double(fade)) }
            out[i] = Float(gain * 0.25 * (sin(2 * .pi * low * t) + sin(2 * .pi * high * t)))
        }
        buffers[key] = buffer
        return buffer
    }
}
