import SwiftUI

/// S101: how a transcript dialog turn is drawn. Pure so the role → side / colour / label rules are testable.
enum TranscriptDialogPolicy {
    enum Side: Equatable, Sendable { case leading, trailing }

    struct Style: Equatable, Sendable {
        let side: Side
        /// Signal token names, mirrored by `background` / `foreground` below.
        let backgroundToken: String
        let foregroundToken: String
        /// Spoken label for VoiceOver.
        let label: String
        /// Small label drawn above the bubble (only the AI has one).
        let tag: String?
    }

    /// Unknown roles (a newer Control) read as the other party rather than failing.
    static func style(role: String) -> Style {
        switch role {
        case "me": Style(side: .trailing, backgroundToken: "bubbleOut", foregroundToken: "white", label: "我", tag: nil)
        case "ai": Style(side: .trailing, backgroundToken: "aiSoft", foregroundToken: "ink", label: "AI", tag: "AI")
        default: Style(side: .leading, backgroundToken: "surface3", foregroundToken: "ink", label: "对方", tag: nil)
        }
    }

    static func background(_ style: Style) -> Color {
        switch style.backgroundToken {
        case "bubbleOut": Signal.bubbleOut
        case "aiSoft": Signal.aiSoft
        default: Signal.surface3
        }
    }

    static func foreground(_ style: Style) -> Color { style.foregroundToken == "white" ? .white : Signal.ink }

    /// `mm:ss` from call start; minutes keep counting past an hour.
    static func timestamp(ms: Double) -> String {
        let seconds = max(0, Int(ms / 1_000))
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }

    /// Space above a turn: none for the first, 4 within the same speaker, 12 when the speaker changes.
    static func spacing(previousRole: String?, role: String) -> CGFloat {
        guard let previousRole else { return 0 }
        return previousRole == role ? 4 : 12
    }

    static let estimateNote = "时间为估算"
    static func showsEstimateNote(maxSkewMs: Double) -> Bool { maxSkewMs > 1_500 }

    /// The dialog when Control sent one with turns; otherwise nil and the by-track blocks render as before.
    static func dialog(for job: TranscriptJob?) -> TranscriptDialog? {
        guard let dialog = job?.dialog, !dialog.turns.isEmpty else { return nil }
        return dialog
    }
}
