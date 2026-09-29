import Darwin
import Foundation

/// This Mac's own tailnet addresses.
///
/// Sent when asking the Mini for a tailnet policy, so the Mac it is generated from is always kept
/// as a client — a policy that locked out the machine you made it on would be the worst possible
/// result. Read from the network interfaces rather than the Tailscale CLI, which may not be
/// installed where the app can find it.
public enum TailnetAddresses {
    public static func current() -> [String] {
        tailnet(from: interfaceAddresses())
    }

    /// Keeps addresses in Tailscale's ranges — 100.64.0.0/10 and fd7a:115c:a1e0::/48 — once each.
    static func tailnet(from addresses: [String]) -> [String] {
        var seen: [String] = []
        for address in addresses where isTailnet(address) && !seen.contains(address) {
            seen.append(address)
        }
        return seen
    }

    static func isTailnet(_ address: String) -> Bool {
        if address.lowercased().hasPrefix("fd7a:115c:a1e0:") { return true }
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        let octets = parts.compactMap { UInt8($0) }
        guard parts.count == 4, octets.count == 4 else { return false }
        return octets[0] == 100 && (64...127).contains(octets[1])
    }

    private static func interfaceAddresses() -> [String] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }

        var addresses: [String] = []
        for entry in sequence(first: first, next: { $0.pointee.ifa_next }) {
            guard let socketAddress = entry.pointee.ifa_addr else { continue }
            let family = Int32(socketAddress.pointee.sa_family)
            guard family == AF_INET || family == AF_INET6 else { continue }
            let length = socklen_t(
                family == AF_INET ? MemoryLayout<sockaddr_in>.size : MemoryLayout<sockaddr_in6>.size
            )
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(socketAddress, length, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else {
                continue
            }
            let text = host.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
            // Link-local IPv6 carries "%interface"; tailnet addresses never do, but a suffix would
            // make an otherwise valid address fail the server's check.
            addresses.append(String(text.split(separator: "%", maxSplits: 1).first ?? ""))
        }
        return addresses
    }
}
