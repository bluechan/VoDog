import AVFAudio

// S112 spike: does Apple's audio converter encode and decode Opus (`kAudioFormatOpus`) on a real watch at 16 kHz mono?
// The watchOS SDK has no AudioToolbox (no `AudioConverterNew` / `AudioConverterFillComplexBuffer`), so this goes through
// AVFAudio's `AVAudioConverter` + `AVAudioCompressedBuffer`, which wrap the same converter. Its initializer returns nil
// without an OSStatus; `convert` reports the OSStatus as the NSError code. Everything refused is recorded, never trapped.
// Both classes are driven from the audio tap thread; each guards its converter with its own lock.

/// "0" / "-50" / "'fmt?' (1718449215)" — OSStatus as both the four-char code and the number when printable.
func osStatusText(_ s: Int) -> String {
    let u = UInt32(truncatingIfNeeded: s)
    let bytes = [24, 16, 8, 0].map { UInt8((u >> UInt32($0)) & 0xFF) }
    if s != 0, bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) { return "'\(String(decoding: bytes, as: UTF8.self))' (\(s))" }
    return "\(s)"
}

/// Runs one `convert` call that hands `input` over once, then reports "no data now". Returns the NSError code (0 = ok).
private func convertOnce(_ converter: AVAudioConverter, _ input: AVAudioBuffer, into output: AVAudioBuffer) -> Int {
    var fed = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
        if fed { inputStatus.pointee = .noDataNow; return nil }
        fed = true
        inputStatus.pointee = .haveData
        return input
    }
    switch status {
    case .haveData, .inputRanDry: return 0
    case .error: return error?.code ?? -1
    case .endOfStream: return -2 // never asked for; would mean the converter ended itself
    @unknown default: return -3
    }
}

private let pcm16k = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

/// PCM16 16 kHz mono → one Opus packet per `frameMs`.
final class WatchOpusEncoder: @unchecked Sendable {
    let frameMs: Int
    /// Converter output format as reported after creation — the decoder's input format.
    private(set) var outputFormat: AVAudioFormat?
    private(set) var magicCookie: Data?
    /// "16000 Hz/320 ok · 24000 bps · 输出 16000 Hz 320 帧/包 · …" or every refused attempt.
    private(set) var inputFormatAccepted = "未创建"
    var ok: Bool { converter != nil }

    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var maxPacketBytes = 1500
    private var _lastStatus = 0
    private var _packetsOut = 0
    private var _bytesOut = 0
    private var _held = 0 // calls that consumed a frame but produced no packet (lookahead/priming)

    var lastStatus: Int { lock.withLock { _lastStatus } }
    var packetsOut: Int { lock.withLock { _packetsOut } }
    var bytesOut: Int { lock.withLock { _bytesOut } }
    var held: Int { lock.withLock { _held } }

    init(sampleRate: Double = 16000, channels: UInt32 = 1, frameMs: Int = 20, bitrate: Int = 24000) {
        self.frameMs = frameMs
        let pcm = sampleRate == 16000 && channels == 1 ? pcm16k
            : AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: AVAudioChannelCount(channels), interleaved: true)!
        var notes: [String] = []
        // 16 kHz Opus first, 48 kHz (Opus's native rate) as the fallback; each with our frame size, then 0 (= codec default).
        attempts: for rate in [sampleRate, 48000] {
            for fpp in [UInt32(Double(frameMs) * rate / 1000), 0] {
                var asbd = AudioStreamBasicDescription()
                asbd.mFormatID = kAudioFormatOpus
                asbd.mSampleRate = rate
                asbd.mChannelsPerFrame = channels
                asbd.mFramesPerPacket = fpp
                guard let opus = AVAudioFormat(streamDescription: &asbd) else { notes.append("\(Int(rate)) Hz/\(fpp) 格式 nil"); continue }
                guard let conv = AVAudioConverter(from: pcm, to: opus) else { notes.append("\(Int(rate)) Hz/\(fpp) 转换器 nil"); continue }
                converter = conv
                notes.append("\(Int(rate)) Hz/\(fpp) ok")
                break attempts
            }
        }
        guard let converter else { inputFormatAccepted = notes.joined(separator: " · "); return }

        // Setting an unsupported bitRate may raise an ObjC exception, so only set one the converter lists.
        let rates = converter.availableEncodeBitRates?.map(\.intValue) ?? []
        if let lo = rates.min(), let hi = rates.max(), (lo...hi).contains(bitrate) {
            converter.bitRate = bitrate
            notes.append(converter.bitRate == bitrate ? "\(bitrate) bps" : "码率 \(bitrate) 未生效 · 实际 \(converter.bitRate) bps")
        } else {
            notes.append("码率 \(bitrate) 不在可选 [\(rates.map(String.init).joined(separator: ","))] · 实际 \(converter.bitRate) bps")
        }

        let out = converter.outputFormat
        outputFormat = out
        let d = out.streamDescription.pointee
        notes.append("输出 \(Int(d.mSampleRate)) Hz \(d.mFramesPerPacket) 帧/包")
        if converter.maximumOutputPacketSize > 0 { maxPacketBytes = converter.maximumOutputPacketSize }
        notes.append("最大包 \(maxPacketBytes) B")
        notes.append("prime \(converter.primeInfo.leadingFrames)/\(converter.primeInfo.trailingFrames)")
        magicCookie = converter.magicCookie
        notes.append("cookie \(magicCookie?.count ?? 0) B")
        if let srs = converter.availableEncodeSampleRates, !srs.isEmpty {
            notes.append("可编 " + srs.map { "\($0.intValue)" }.joined(separator: ","))
        }
        inputFormatAccepted = notes.joined(separator: " · ")
    }

    /// `pcm` must be exactly `frameMs` of PCM16 mono at the input rate. Returns one Opus packet, or nil when the
    /// converter failed (`lastStatus` ≠ 0) or is still holding input for lookahead (`lastStatus` == 0, `held` += 1).
    func encode(_ pcm: Data) -> Data? {
        lock.withLock {
            guard let converter, let outputFormat else { return nil }
            let frames = AVAudioFrameCount(pcm.count / 2)
            guard let input = AVAudioPCMBuffer(pcmFormat: converter.inputFormat, frameCapacity: frames), let dst = input.int16ChannelData?[0] else {
                _lastStatus = -4; return nil
            }
            input.frameLength = frames
            pcm.withUnsafeBytes { dst.update(from: $0.bindMemory(to: Int16.self).baseAddress!, count: Int(frames)) }
            let output = AVAudioCompressedBuffer(format: outputFormat, packetCapacity: 1, maximumPacketSize: maxPacketBytes)
            let status = convertOnce(converter, input, into: output)
            _lastStatus = status
            guard status == 0 else { return nil }
            guard output.packetCount > 0, output.byteLength > 0 else { _held += 1; return nil }
            let desc = output.packetDescriptions?[0]
            let start = Int(desc?.mStartOffset ?? 0)
            let size = Int(desc?.mDataByteSize ?? output.byteLength)
            let packet = Data(bytes: output.data + start, count: size)
            _packetsOut += 1
            _bytesOut += packet.count
            return packet
        }
    }
}

/// One Opus packet (format = the encoder's reported output format) → PCM16 mono 16 kHz.
final class WatchOpusDecoder: @unchecked Sendable {
    /// "ok · 320 帧/包 · cookie 0 B" or the failure.
    private(set) var note = "未创建"
    var ok: Bool { converter != nil }

    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private let input: AVAudioFormat
    private let framesOut: AVAudioFrameCount
    private var _lastStatus = 0
    private var _packetsIn = 0
    private var _framesOut = 0

    var lastStatus: Int { lock.withLock { _lastStatus } }
    var packetsIn: Int { lock.withLock { _packetsIn } }
    var totalFramesOut: Int { lock.withLock { _framesOut } }

    init(input: AVAudioFormat, magicCookie: Data?, frameMs: Int) {
        self.input = input
        let d = input.streamDescription.pointee
        let fpp = d.mFramesPerPacket > 0 ? Double(d.mFramesPerPacket) : Double(frameMs) * d.mSampleRate / 1000
        framesOut = AVAudioFrameCount(fpp * 16000 / max(d.mSampleRate, 1))
        guard let conv = AVAudioConverter(from: input, to: pcm16k) else { note = "转换器 nil"; return }
        if let magicCookie, !magicCookie.isEmpty { conv.magicCookie = magicCookie }
        converter = conv
        note = "ok · \(framesOut) 帧/包 · cookie \(magicCookie?.count ?? 0) B"
    }

    /// Returns the PCM16 produced for this packet (normally `frameMs`; may be shorter while the decoder primes), or nil on error.
    func decode(_ packet: Data) -> Data? {
        lock.withLock {
            guard let converter, !packet.isEmpty else { return nil }
            _packetsIn += 1
            let compressed = AVAudioCompressedBuffer(format: input, packetCapacity: 1, maximumPacketSize: packet.count)
            packet.withUnsafeBytes { compressed.data.copyMemory(from: $0.baseAddress!, byteCount: packet.count) }
            compressed.byteLength = UInt32(packet.count)
            compressed.packetCount = 1
            compressed.packetDescriptions?[0] = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count))
            guard let output = AVAudioPCMBuffer(pcmFormat: pcm16k, frameCapacity: framesOut), let src = output.int16ChannelData?[0] else {
                _lastStatus = -4; return nil
            }
            let status = convertOnce(converter, compressed, into: output)
            _lastStatus = status
            guard status == 0 else { return nil }
            _framesOut += Int(output.frameLength)
            return Data(bytes: src, count: Int(output.frameLength) * 2)
        }
    }
}
