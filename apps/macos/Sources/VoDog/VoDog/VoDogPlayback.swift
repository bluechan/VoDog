import AppKit
import AVFoundation
import Foundation
import UniformTypeIdentifiers

/// 单一播放器：先用 `account.data` 把整轨下载到本地缓存（`VoDogAccount.recordingCacheDirectory`）再交给 AVPlayer；
/// 缓存命中直接播放，不再下载。
/// shortcut: 缓存只按 callId/source/track 命名（Mac 清单没有 sha256），服务器重建同一轨（如归档修复）后仍播旧文件，
/// 直到本机删除该通话或被淘汰；清单带上 sha256 时再像 iOS RecordingPlaybackCache 那样校验。
/// ponytail: 整轨下载而非流式；15 分钟令牌 + AVPlayer 的 Range 续传才是不可靠的那条路。
/// 录音很大、首播太慢时再改为 AVURLAsset + `AVURLAssetHTTPHeaderFieldsKey`（authorizedRequest 已备好）。
@MainActor
final class VoDogRecordingPlayer: ObservableObject {
    struct Key: Equatable { var callId: String; var track: String; var source: String }

    @Published private(set) var current: Key?
    @Published private(set) var loading = false
    @Published private(set) var isPlaying = false
    @Published private(set) var currentTime: Double = 0
    @Published private(set) var duration: Double = 0
    @Published var error: String?

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var loadTask: Task<Void, Never>?

    func isCurrent(_ key: Key) -> Bool { current == key }

    func toggle(_ key: Key, account: VoDogAccount) {
        switch CCPlaybackPolicy.action(isCurrent: current == key, hasPlayer: player != nil, isPlaying: isPlaying) {
        case .pause: pause()
        case .resume: resume()
        case .restart: play(key, account: account)
        }
    }

    func play(_ key: Key, account: VoDogAccount) {
        stop()
        current = key
        loading = true
        error = nil
        let started = Date()
        loadTask = Task { [weak self] in
            var bytes = 0
            var result = "ok"
            var cached = false
            defer {
                account.diag("records.play", callId: key.callId, fields: [
                    "track": key.track, "source": key.source, "result": result,
                    "ms": Int(Date().timeIntervalSince(started) * 1_000), "bytes": bytes, "cached": cached,
                ])
            }
            do {
                // 整段加载（下载 + 可播检查 + mp3 回退）受看门狗约束（混音 90 s、单轨 30 s）：蜂窝网络卡住时给出错误而不是无限转圈。
                let fetch: @Sendable (Bool) async throws -> Data = { mp3 in
                    try await Self.fetch(key, mp3: mp3, account: account)
                }
                let (url, size, hit) = try await CCAsync.withTimeout(CCPlaybackPolicy.loadTimeoutSeconds(track: key.track)) {
                    try await Self.load(key, fetch: fetch)
                }
                bytes = size
                cached = hit
                // 已写入缓存的文件留着下次用，不删。
                guard let self, !Task.isCancelled, self.current == key else { result = "cancelled"; return }
                self.start(url)
            } catch {
                if error is CancellationError || Task.isCancelled { result = "cancelled"; return }
                result = error is CCTimeoutError ? "timeout" : "error"
                guard let self, self.current == key else { return }
                self.loading = false
                self.error = error is CCTimeoutError ? VoDogErrorText.shown(L10n.tr("加载超时，请重试"), error: error)
                    : VoDogRecordsError.message(error)
            }
        }
    }

    func pause() { player?.pause(); isPlaying = false }
    func resume() { player?.play(); isPlaying = player != nil }

    func seek(to seconds: Double) {
        player?.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
        currentTime = seconds
    }

    func stop() {
        loadTask?.cancel(); loadTask = nil
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        timeObserver = nil; endObserver = nil
        player?.pause(); player = nil
        current = nil; loading = false; isPlaying = false; currentTime = 0; duration = 0
    }

    private func start(_ url: URL) {
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        self.player = player
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main
        ) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.currentTime = time.seconds.isFinite ? time.seconds : 0
                let total = item.duration.seconds
                if total.isFinite, total > 0 { self.duration = total }
            }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.isPlaying = false
                self?.player?.seek(to: .zero)
                self?.currentTime = 0
            }
        }
        loading = false
        player.play()
        isPlaying = true
    }

    @MainActor
    private static func fetch(_ key: Key, mp3: Bool, account: VoDogAccount) async throws -> Data {
        var query = ["source": key.source]
        if mp3 { query["format"] = "mp3" }
        return try await account.data("GET", "/calls/\(key.callId)/recordings/\(key.track)", query: query)
    }

    /// 缓存命中直接返回；否则下载写入缓存。原格式不可播时退到服务器转码的 mp3（`conversation` 只有 mp3，Pixel 单轨先要 mp3）。
    /// shortcut: Pixel 单轨的 mp3 请求失败不再退回 WAV（服务器已预转码）；出现 mp3 缺失时再加。
    nonisolated static func load(_ key: Key, fetch: @Sendable (Bool) async throws -> Data) async throws -> (URL, Int, Bool) {
        let mp3First = CCPlaybackPolicy.mp3First(track: key.track, source: key.source)
        let original = mp3First ? "mp3" : (key.source == "pixel" ? "wav" : "ogg")
        // 原格式不可播时退成的 mp3 也存在同一 stem 下，一并查找。
        for ext in Set([original, "mp3"]).sorted() {
            let url = cacheURL(key, ext: ext)
            if let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size > 0 {
                try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
                return (url, size, true)
            }
        }
        var data = try await fetch(mp3First)
        var url = try write(data, to: cacheURL(key, ext: original))
        if !mp3First, !(try await AVURLAsset(url: url).load(.isPlayable)) {
            try? FileManager.default.removeItem(at: url)
            data = try await fetch(true)
            url = try write(data, to: cacheURL(key, ext: "mp3"))
        }
        prune(keeping: url)
        return (url, data.count, false)
    }

    /// 本机删除通话后清掉它的全部缓存录音。
    nonisolated static func removeCached(callId: String) {
        let dir = VoDogAccount.recordingCacheDirectory
        let prefix = CCRecordingCacheNaming.callPrefix(callId)
        for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
        }
    }

    nonisolated private static func cacheURL(_ key: Key, ext: String) -> URL {
        VoDogAccount.recordingCacheDirectory.appendingPathComponent(
            CCRecordingCacheNaming.fileName(callId: key.callId, source: key.source, track: key.track, ext: ext))
    }

    nonisolated private static func write(_ data: Data, to url: URL) throws -> URL {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return url
    }

    /// 超出上限按修改时间删旧文件；刚写入、即将播放的那个不删。
    nonisolated private static func prune(keeping current: URL) {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: VoDogAccount.recordingCacheDirectory, includingPropertiesForKeys: keys)) ?? []
        let files = urls.compactMap { url -> (url: URL, size: Int, mtime: Date)? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }
        for url in CCRecordingCacheNaming.pruneSelection(files) where url.standardizedFileURL != current.standardizedFileURL {
            try? FileManager.default.removeItem(at: url)
        }
    }
}

enum VoDogRecordsError {
    /// 统一错误文案（已本地化）；同时记 S69 `ui.error_shown`。
    static func message(_ error: Error, file: String = #fileID, site: String = #function) -> String {
        let text = text(for: error)
        VoDogErrorText.reportShown(text, error, file: file, site: site)
        return text
    }

    private static func text(for error: Error) -> String {
        if let api = error as? VoDogAPIError {
            switch (api.status, api.code) {
            case (409, "CALL_IN_USE"): return L10n.tr("通话仍在进行或处理中，稍后再删除。")
            case (404, _): return L10n.tr("这条记录已不存在或尚未生成。")
            case (503, "PIXEL_ARCHIVE_DISABLED"): return L10n.tr("设备原始归档尚未开启。")
            case (501, _): return L10n.tr("服务器暂不支持导出 MP3。")
            case (0, "NOT_IMPLEMENTED"): return L10n.tr("VoDog 账号尚未就绪。")
            default:
                return L10n.tr("请求失败（%@）", "\(api.status) \(api.code ?? "")".trimmingCharacters(in: .whitespaces))
            }
        }
        if error is URLError { return L10n.tr("网络暂时不可用，请检查网络后重试。") }
        return error.localizedDescription
    }
}

enum VoDogRecordingExport {
    /// NSSavePanel → mp3 导出（`track=conversation` 为双方混音）。
    @MainActor
    static func export(callId: String, track: String, source: String, account: VoDogAccount) async throws -> Bool {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "\(callId)-\(track).mp3"
        panel.allowedContentTypes = [.mp3]
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        let data = try await account.data(
            "GET", "/calls/\(callId)/recordings/\(track)",
            query: ["source": source, "format": "mp3", "disposition": "attachment"]
        )
        try data.write(to: url, options: .atomic)
        return true
    }
}
