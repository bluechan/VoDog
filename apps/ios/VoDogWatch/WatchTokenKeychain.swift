import Foundation
import Security

/// The watch's copy of the iPhone-issued access token. It lives in the Keychain, not in the UserDefaults
/// snapshot: defaults are a plaintext plist. Failures are not fatal: without a stored token the watch
/// waits for the iPhone's next applicationContext.
enum WatchTokenKeychain {
    private static var service: String { Bundle.main.bundleIdentifier ?? "org.vodog.watch" }
    private static let account = "access-token"

    @discardableResult
    static func save(_ token: String) -> Bool {
        delete()
        return SecItemAdd([
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
            kSecValueData: Data(token.utf8), kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ] as CFDictionary, nil) == errSecSuccess
    }

    static func load() -> String? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
            kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
        ] as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete() {
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account] as CFDictionary)
    }
}
