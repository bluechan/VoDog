import AppKit
import SwiftUI

/// VoDog mascot illustration from `Contents/Resources/Illustrations/<name>.png` (spec S103).
/// VoDog ships no mascot PNGs (provenance), so `fallbackSystemImage` keeps the SF Symbol empty state;
/// without a fallback it renders nothing (self-tests, `swift run` without a bundle).
/// Floats gently unless Reduce Motion is on.
struct VoDogIllustration: View {
    let name: String
    let width: CGFloat
    let fallbackSystemImage: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var floating = false

    init(_ name: String, width: CGFloat, fallbackSystemImage: String? = nil) {
        self.name = name
        self.width = width
        self.fallbackSystemImage = fallbackSystemImage
    }

    var body: some View {
        if let url = Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "Illustrations"),
           let image = NSImage(contentsOf: url) {
            Image(nsImage: image)
                .resizable()
                .scaledToFit()
                .frame(width: width)
                .offset(y: floating && !reduceMotion ? -4 : 0)
                .animation(
                    reduceMotion ? nil : .easeInOut(duration: 2.5).repeatForever(autoreverses: true),
                    value: floating
                )
                .onAppear { floating = true }
                .accessibilityHidden(true)
        } else if let fallbackSystemImage {
            Image(systemName: fallbackSystemImage)
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
    }
}
