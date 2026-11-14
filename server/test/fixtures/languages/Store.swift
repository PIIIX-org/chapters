import Foundation
import struct Models.Entry
@testable import Storage

public func openStore() -> Store {
    func localHelper() {}
    return Store()
}

public class Store {
    public func load() -> String {
        func decode() -> String { "local" }
        return decode()
    }

    class func create() -> Store { Store() }

    class Nested {
        func hidden() {}
    }
}

struct Entry {
    func key() -> String { "entry" }
}

public enum Event {
    case saved
    func label() -> String { "saved" }
}

public protocol Backend {
    func load() -> String
    static func create() -> Self
}

extension Store: Backend {
    func save() {
        func encode() {}
        encode()
    }
}

extension Backend {
    func close() {}
}

extension Models.Entry {
    func normalized() -> String { key().lowercased() }
}

extension Array where Element == Entry {
    func keys() -> [String] { map { $0.key() } }
}

private func helper() {}
open class DiskStore {
    open func read() {}
}

func localTypes() {
    struct Local {
        func hidden() {}
    }
}
