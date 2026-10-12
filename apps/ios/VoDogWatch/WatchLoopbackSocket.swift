import Foundation
import Network

// S112d spike: the loopback page's server stages over either URLSession (default, may ride the iPhone Bluetooth proxy)
// or Network.framework pinned to the watch's own Wi-Fi. No fallback on purpose: we want to see how the Wi-Fi path fails.

enum LoopbackNetwork: String, CaseIterable, Sendable {
    case standard = "default", wifi
    var label: String { self == .wifi ? "强制 Wi-Fi" : "默认" }
}

struct LoopbackSocketError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Main-actor callbacks. The controller identity-checks the socket (`===`) inside each one.
struct LoopbackSocketEvents {
    var opened: @MainActor (_ ms: Int, _ interface: String) -> Void // NW only: ms until `.ready`, interface actually used
    var text: @MainActor (String) -> Void
    var data: @MainActor (Data) -> Void
    var failed: @MainActor (Error) -> Void
}

@MainActor protocol LoopbackSocket: AnyObject, Sendable {
    /// Close code from the server's close frame, if one was seen.
    var closeCode: Int? { get }
    func open(_ events: LoopbackSocketEvents)
    /// `done` may run on any thread (the controller times the first completion as the open latency).
    func sendText(_ text: String, done: @escaping @Sendable (Error?) -> Void)
    func sendData(_ data: Data, done: @escaping @Sendable (Error?) -> Void)
    func cancel()
}

@MainActor final class URLSessionLoopbackSocket: LoopbackSocket {
    private let task: URLSessionWebSocketTask

    init(url: URL, token: String?) {
        var request = URLRequest(url: url)
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        task = URLSession.shared.webSocketTask(with: request)
    }

    var closeCode: Int? { task.closeCode == .invalid ? nil : task.closeCode.rawValue }

    func open(_ events: LoopbackSocketEvents) {
        task.resume()
        let task = task
        Task { @MainActor [weak self] in
            while true {
                do {
                    let message = try await task.receive()
                    guard self != nil else { return }
                    switch message {
                    case .data(let data): events.data(data)
                    case .string(let text): events.text(text)
                    @unknown default: break
                    }
                } catch {
                    if self != nil { events.failed(error) }
                    return
                }
            }
        }
    }

    func sendText(_ text: String, done: @escaping @Sendable (Error?) -> Void) { task.send(.string(text), completionHandler: done) }
    func sendData(_ data: Data, done: @escaping @Sendable (Error?) -> Void) { task.send(.data(data), completionHandler: done) }
    func cancel() { task.cancel(with: .normalClosure, reason: nil) }
}

@MainActor final class NWLoopbackSocket: LoopbackSocket {
    private let conn: NWConnection
    private let t0 = DispatchTime.now().uptimeNanoseconds
    private var events: LoopbackSocketEvents?
    private var budget: Task<Void, Never>?
    private var openMs: Int?
    private var lastState = "setup"
    private var finished = false // cancelled or failed: no more events
    private var pending: [(Data, NWProtocolWebSocket.Opcode, @Sendable (Error?) -> Void)] = [] // sends issued before `.ready`
    private(set) var closeCode: Int?

    init(url: URL, token: String?) {
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        if let token { ws.setAdditionalHeaders([(name: "Authorization", value: "Bearer \(token)")]) }
        let params = NWParameters.tls
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.requiredInterfaceType = .wifi
        conn = NWConnection(to: .url(url), using: params)
    }

    private var elapsedMs: Int { Int((DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000) }

    func open(_ events: LoopbackSocketEvents) {
        self.events = events
        conn.stateUpdateHandler = { @Sendable [weak self] state in Task { @MainActor in self?.stateChanged(state) } }
        conn.start(queue: .main)
        budget = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, !Task.isCancelled, self.openMs == nil else { return }
            self.fail(LoopbackSocketError(message: "Wi-Fi 3 s 内未就绪（state \(self.lastState)）"))
        }
    }

    private func stateChanged(_ state: NWConnection.State) {
        lastState = String(String(describing: state).prefix(120))
        WatchDiag.log("watch.spike.nw_state", ["state": .string(lastState), "ms": .int(elapsedMs)])
        switch state {
        case .ready:
            guard !finished, openMs == nil else { return }
            budget?.cancel()
            let ms = elapsedMs
            openMs = ms
            let path = conn.currentPath
            let interface = path == nil ? "unknown"
                : path!.usesInterfaceType(.wifi) ? "wifi"
                : path!.usesInterfaceType(.cellular) ? "cellular"
                : path!.usesInterfaceType(.wiredEthernet) ? "wired"
                : path!.usesInterfaceType(.other) ? "other" : "unknown"
            events?.opened(ms, interface)
            let queued = pending
            pending = []
            for (data, opcode, done) in queued { send(data, opcode, done) }
            receive()
        case .failed(let error):
            fail(error)
        default: break // .waiting(err) is only remembered in lastState; the 3 s budget turns it into the failure
        }
    }

    private func receive() {
        conn.receiveMessage { @Sendable [weak self] content, context, _, error in
            Task { @MainActor in self?.received(content, context, error) }
        }
    }

    private func received(_ content: Data?, _ context: NWConnection.ContentContext?, _ error: NWError?) {
        guard !finished else { return }
        if let error { fail(error); return }
        let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
        switch meta?.opcode {
        case .close?:
            closeCode = switch meta!.closeCode {
            case .protocolCode(let code): Int(code.rawValue)
            case .applicationCode(let code), .privateCode(let code): Int(code)
            @unknown default: nil
            }
            fail(LoopbackSocketError(message: "服务器关闭连接"))
            return
        case .text?: if let content { events?.text(String(decoding: content, as: UTF8.self)) }
        case .binary?: if let content { events?.data(content) }
        default:
            if content == nil, context == nil { fail(LoopbackSocketError(message: "连接已结束")); return }
        }
        if !finished { receive() }
    }

    private func fail(_ error: Error) {
        guard !finished else { return }
        finished = true
        budget?.cancel()
        conn.cancel()
        events?.failed(error)
    }

    private func send(_ data: Data, _ opcode: NWProtocolWebSocket.Opcode, _ done: @escaping @Sendable (Error?) -> Void) {
        guard openMs != nil else { pending.append((data, opcode, done)); return }
        let context = NWConnection.ContentContext(identifier: "ws", metadata: [NWProtocolWebSocket.Metadata(opcode: opcode)])
        conn.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { @Sendable err in done(err) })
    }

    func sendText(_ text: String, done: @escaping @Sendable (Error?) -> Void) { send(Data(text.utf8), .text, done) }
    func sendData(_ data: Data, done: @escaping @Sendable (Error?) -> Void) { send(data, .binary, done) }

    func cancel() {
        finished = true
        budget?.cancel()
        conn.cancel()
    }
}
