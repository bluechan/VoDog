import AppKit
import os
import SwiftUI

private let smsLinkLogger = Logger(subsystem: "org.vodog.macos", category: "SMSLink")

/// S87: SMS body with tappable links. Link runs are underlined and keep the bubble's text colour (the default link
/// tint vanishes on the accent background); `linked: false` (selection mode) renders the plain body. Clicks are
/// intercepted by the page's `smsLinkConfirmHost()` — nothing opens without the 「打开链接？」 confirmation.
enum SMSLinkText {
    static func attributed(_ text: String, color: Color, linked: Bool) -> AttributedString {
        var result = AttributedString(text)
        guard linked else { return result }
        for link in SMSLinkPolicy.links(in: text) {
            guard let url = URL(string: link.url), SMSLinkPolicy.isOpenable(url),
                  let range = Range(link.range, in: result) else { continue }
            result[range].link = url
            result[range].underlineStyle = .single
            result[range].foregroundColor = color
        }
        return result
    }
}

/// S87 fix: on macOS a `.textSelection(.enabled)` Text opens link clicks itself, bypassing the `openURL`
/// override (build 152 opened Chrome with no alert). So a body with links is not selectable (copy via the
/// right-click 复制); a body without links (or in selection mode) keeps native drag-select.
struct SMSBodyText: View {
    let text: String
    let color: Color
    let linked: Bool

    var body: some View {
        let attributed = SMSLinkText.attributed(text, color: color, linked: linked)
        if attributed.runs.contains(where: { $0.link != nil }) {
            Text(attributed)  // clicks go to the page's smsLinkConfirmHost()
        } else {
            Text(attributed).textSelection(.enabled)
        }
    }
}

/// One confirm per screen, on a view that hosts no other presentation. Build 153's per-bubble alert never showed
/// (suspected: the detail VStack's confirmationDialog wins the presentation); the "link tap" log tells whether the
/// click reached OpenURLAction at all.
private struct SMSLinkConfirmHost: ViewModifier {
    @State private var pending: URL?

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                smsLinkLogger.notice("link tap \(url.host ?? "-", privacy: .public)")
                pending = url
                return .handled
            })
            .alert(L10n.tr("打开链接？"),
                   isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                   presenting: pending) { url in
                Button(L10n.tr("打开")) {
                    if SMSLinkPolicy.isOpenable(url) { NSWorkspace.shared.open(url) }
                }
                Button(L10n.tr("取消"), role: .cancel) {}
            } message: { url in
                Text(verbatim: url.absoluteString)
            }
    }
}

extension View {
    /// Routes link clicks inside this view (an SMS page's scroll container) through the S87 confirmation.
    func smsLinkConfirmHost() -> some View { modifier(SMSLinkConfirmHost()) }
}
