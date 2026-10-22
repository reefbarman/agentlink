// AgentLink Credentials: the single program that reads and writes AgentLink's
// shared macOS Keychain items.
//
// Why it exists: macOS resets an item's trusted-team (partition) list to the
// writer's team on every write. VS Code's extension host is signed by
// Microsoft and the CLI and Desktop by AgentLink, so whichever surface wrote
// last locked the others out and they asked for Keychain access again. When
// every surface goes through this helper, every write comes from the same
// signature, so one "Always Allow" lasts.
//
// Each surface ships a copy named for itself, for example
// "AgentLink Credentials (VS Code)". macOS names the program in its prompt,
// so the prompt says which surface is asking, while all copies share one
// signature and therefore one approval.
//
// Protocol: one JSON request on stdin, one JSON reply on stdout.
//   {"op":"get"|"store"|"delete","service":"...","account":"...",
//    "label":"...","value":"..."}
//   -> {"ok":true,"value":"..."|null} or
//      {"ok":false,"error":"caller_rejected"|"invalid_request"|"keychain_error",
//       "status":<OSStatus>,"message":"..."}
// Secrets never appear in arguments. The helper does nothing else: it is not
// an interpreter and accepts no code.

import Foundation
import Security

struct Request: Decodable {
  let op: String
  let service: String
  let account: String
  let label: String?
  let value: String?
}

func reply(_ body: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{\"ok\":false}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(body["ok"] as? Bool == true ? 0 : 1)
}

func fail(_ error: String, status: OSStatus = 0, message: String = "") -> Never {
  var body: [String: Any] = ["ok": false, "error": error]
  if status != 0 {
    body["status"] = Int(status)
    body["message"] = (SecCopyErrorMessageString(status, nil) as String?) ?? message
  } else if !message.isEmpty {
    body["message"] = message
  }
  reply(body)
}

// MARK: Caller check

/// The team that signed this helper, so AgentLink's own surfaces are allowed
/// without hard-coding the team at build time.
func ownTeam() -> String? {
  var selfCode: SecCode?
  guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode else { return nil }
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(selfCode, [], &staticCode) == errSecSuccess, let staticCode else {
    return nil
  }
  var info: CFDictionary?
  guard
    SecCodeCopySigningInformation(
      staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
    let dictionary = info as? [String: Any]
  else { return nil }
  return dictionary[kSecCodeInfoTeamIdentifier as String] as? String
}

/// Only VS Code's extension host and AgentLink's own signed CLI and Desktop
/// may use the helper. This is defence in depth rather than a boundary: the
/// CLI runtime and Desktop can run scripts, as VS Code's extension host runs
/// every installed extension, which matches the trust "Always Allow" gives
/// those programs today.
func callerAllowed() -> Bool {
  let parent = getppid()
  var guest: SecCode?
  let attributes = [kSecGuestAttributePid: NSNumber(value: parent)] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
    let guest
  else { return false }
  var requirements = [
    "anchor apple generic and certificate leaf[subject.OU] = \"UBF8T346G9\" and "
      + "(identifier \"com.microsoft.VSCode.helper\" or identifier \"com.microsoft.VSCodeInsiders.helper\")"
  ]
  if let team = ownTeam(), !team.isEmpty {
    requirements.append(
      "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and "
        + "(identifier \"com.agentlink.cli.node\" or identifier \"com.agentlink.desktop\")")
  }
  for text in requirements {
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
      let requirement
    else { continue }
    if SecCodeCheckValidity(guest, [], requirement) == errSecSuccess { return true }
  }
  return false
}

// MARK: Keychain

func baseQuery(_ request: Request) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: request.service,
    kSecAttrAccount as String: request.account,
  ]
}

func get(_ request: Request) -> Never {
  var query = baseQuery(request)
  query[kSecReturnData as String] = true
  query[kSecReturnAttributes as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound { reply(["ok": true, "value": NSNull()]) }
  guard status == errSecSuccess, let item = result as? [String: Any] else {
    fail("keychain_error", status: status)
  }
  guard let data = item[kSecValueData as String] as? Data,
    let value = String(data: data, encoding: .utf8)
  else { fail("keychain_error", message: "The stored value is not UTF-8 text.") }
  // Label items written before the helper existed, so later prompts name the
  // credential. A label change is best effort and never fails the read.
  if let label = request.label, !label.isEmpty,
    item[kSecAttrLabel as String] as? String != label
  {
    _ = SecItemUpdate(
      baseQuery(request) as CFDictionary, [kSecAttrLabel as String: label] as CFDictionary)
  }
  reply(["ok": true, "value": value])
}

func store(_ request: Request) -> Never {
  guard let value = request.value else { fail("invalid_request", message: "A value is required.") }
  var update: [String: Any] = [kSecValueData as String: Data(value.utf8)]
  if let label = request.label, !label.isEmpty { update[kSecAttrLabel as String] = label }
  var status = SecItemUpdate(baseQuery(request) as CFDictionary, update as CFDictionary)
  if status == errSecItemNotFound {
    var add = baseQuery(request)
    add.merge(update) { _, new in new }
    status = SecItemAdd(add as CFDictionary, nil)
  }
  guard status == errSecSuccess else { fail("keychain_error", status: status) }
  reply(["ok": true, "value": NSNull()])
}

func delete(_ request: Request) -> Never {
  let status = SecItemDelete(baseQuery(request) as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else {
    fail("keychain_error", status: status)
  }
  reply(["ok": true, "value": NSNull()])
}

// MARK: Main

let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 4 * 1024 * 1024,
  let request = try? JSONDecoder().decode(Request.self, from: input),
  !request.service.isEmpty, request.service.count <= 200,
  !request.account.isEmpty, request.account.count <= 200
else { fail("invalid_request", message: "Expected one JSON request on stdin.") }
guard callerAllowed() else {
  fail("caller_rejected", message: "Only AgentLink and VS Code may use this helper.")
}
switch request.op {
case "get": get(request)
case "store": store(request)
case "delete": delete(request)
default: fail("invalid_request", message: "Unknown operation.")
}
