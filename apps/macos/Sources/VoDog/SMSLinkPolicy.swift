import Foundation

/// S87: links in an SMS body. The regex is the one in the spec, character for character, shared with Web, iOS and
/// Android; the body is untrusted input, so only http/https ever leaves the app. Foundation-only so the self-tests
/// can compile it without SwiftUI (styling lives in SMSLinkText.swift).
enum SMSLinkPolicy {
    struct Link: Equatable {
        let range: NSRange
        let url: String
    }

    static let pattern = #"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+|(?<![@A-Za-z0-9.\-/:])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:com|cn|net|org|top|xyz|cc|vip|info|me|io|co|app|shop|link)(?![A-Za-z0-9-])(?::\d+)?(?:/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*)?"#
    private static let regex = try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    private static let trailing = Set(".,;:!?'\")]}*".utf16)

    static func links(in text: String) -> [Link] {
        let ns = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { match in
            var length = match.range.length
            while length > 0, trailing.contains(ns.character(at: match.range.location + length - 1)) { length -= 1 }
            let range = NSRange(location: match.range.location, length: length)
            let raw = ns.substring(with: range)
            let lower = raw.lowercased()
            if raw.isEmpty || lower == "http://" || lower == "https://" { return nil }
            let hasScheme = lower.hasPrefix("http://") || lower.hasPrefix("https://")
            return Link(range: range, url: hasScheme ? raw : "http://" + raw)
        }
    }

    static func isOpenable(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }
}
