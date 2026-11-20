import Foundation
import Network

struct CheckoutError: LocalizedError {
  let text: String
  static func message(_ text: String) -> Self { .init(text:text) }
  var errorDescription: String? { text }
}
struct ValidatorInfo: Codable, Equatable { let key:String; let power:String }
struct ValidatorSnapshot: Codable, Equatable { let chain:Int; let from:Int; let to:Int; let validators:[ValidatorInfo] }
struct Config: Codable { let chain: Int; let contract: String; let rpc: String; let mode: String; let validatorSnapshot:ValidatorSnapshot? }
struct ReceiveIntent: Codable { let v: Int; let kind: String; let chain: Int; let contract: String; let id: String; let vendor: String; let amount: String; let deadline: Int; let signature: String; let merchantName: String? }
struct SendIntent: Codable { let v: Int; let kind: String; let chain: Int; let contract: String; let id: String; let vendor: String; let payer: String; let amount: String; let deadline: Int; let signature: String }
struct PaymentPackage: Codable { let v:Int; let kind:String; let receive:ReceiveIntent; let send:SendIntent }
struct ProofEnvelope: Decodable { let kind:String; let id:String; let vendor:String; let txHash:String? }
struct Order: Codable, Identifiable {
  let receive: ReceiveIntent
  let send: SendIntent
  var status: String
  var uploaded: Bool
  var txHash: String?
  var proofJSON: String?
  var error: String?
  let created: Date
  var id: String { send.id }
}
struct ServerState: Codable { let status: String; let txHash: String?; let error: String? }

@MainActor final class CheckoutModel: ObservableObject {
  @Published var config: Config?
  @Published var address = ""
  @Published var balance = "0"
  @Published var walletBalance = "0"
  @Published var legacyBalance = "0"
  @Published var orders: [Order] = []
  @Published var pendingReceive: ReceiveIntent?
  @Published var selectedOrderID: String?
  @Published var screen: Screen = .home
  @Published var message: String?
  @Published var busy = false
  static let hostedBackend = "https://blackout-next.64-177-121-208.sslip.io"
  @Published var backend: String = {
    let saved = UserDefaults.standard.string(forKey:"backend") ?? ""
    if saved.isEmpty || saved.contains("trycloudflare.com") || saved == "http://192.168.1.64:4173" || saved == "https://blackout.64-177-121-208.sslip.io" {
      return hostedBackend
    }
    return saved
  }()
  @Published var showingSettings = false
  @Published var showingScanner = false
  @Published var showingImport = false
  @Published var recoveryKey = ""
  private var monitor: NWPathMonitor?
  enum Screen { case home, confirm, proof, activity }
  init() {
    UserDefaults.standard.set(backend,forKey:"backend")
    if let data = UserDefaults.standard.data(forKey:"orders"), let stored = try? JSONDecoder().decode([Order].self,from:data) { orders = stored }
    if let data = UserDefaults.standard.data(forKey:"config"), let stored = try? JSONDecoder().decode(Config.self,from:data) { config = stored }
    balance = UserDefaults.standard.string(forKey:"escrowBalance") ?? "0"
    Task { await initialize() }
    let monitor = NWPathMonitor(); self.monitor = monitor
    monitor.pathUpdateHandler = { [weak self] path in if path.status == .satisfied { Task { @MainActor in await self?.sync() } } }
    monitor.start(queue:DispatchQueue(label:"blackout.network"))
    Task { [weak self] in while true { try? await Task.sleep(for:.seconds(15)); await self?.sync() } }
  }
  func initialize() async {
    do {
      let key = try SecureWallet.read() ?? SecureWallet.create()
      address = try await CryptoBridge.shared.address(key:key)
      do {try await refreshConfig()} catch {if config == nil {message = error.localizedDescription}}
      await sync()
    } catch { message = error.localizedDescription }
  }
  func setBackend(_ text: String) async {
    backend = text.trimmingCharacters(in:.whitespacesAndNewlines).trimmingCharacters(in:CharacterSet(charactersIn:"/"))
    UserDefaults.standard.set(backend,forKey:"backend")
    do { try await refreshConfig(); await sync() } catch { message = error.localizedDescription }
  }
  private func url(_ path: String) throws -> URL {
    guard let base = URL(string:backend), let host = base.host, !host.isEmpty, let url=URL(string:path,relativeTo:base)?.absoluteURL else { throw CheckoutError.message("Enter the matcher URL in Settings") }
    return url
  }
  private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
    var request=URLRequest(url:try url(path)); request.timeoutInterval=12; request.cachePolicy = .reloadIgnoringLocalCacheData
    let (data,response)=try await URLSession.shared.data(for:request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw CheckoutError.message(String(data:data,encoding:.utf8) ?? "Matcher unavailable") }
    return try JSONDecoder().decode(T.self,from:data)
  }
  private func getRaw(_ path:String) async throws -> String {
    var request=URLRequest(url:try url(path));request.timeoutInterval=30;request.cachePolicy = .reloadIgnoringLocalCacheData
    let (data,response)=try await URLSession.shared.data(for:request)
    guard (response as? HTTPURLResponse)?.statusCode == 200,let text=String(data:data,encoding:.utf8) else {throw CheckoutError.message("Settlement proof unavailable")}
    return text
  }
  private func officialValidatorCall(height:Int) async throws -> String {
    var request=URLRequest(url:URL(string:"https://rpc.testnet.arc.io")!)
    request.httpMethod="POST";request.timeoutInterval=15
    request.setValue("application/json",forHTTPHeaderField:"Content-Type")
    request.httpBody=try JSONSerialization.data(withJSONObject:["jsonrpc":"2.0","id":1,"method":"eth_call","params":[["to":"0x3600000000000000000000000000000000000002","data":"0x24408a68"],"0x"+String(height,radix:16)]])
    let (data,response)=try await URLSession.shared.data(for:request)
    guard (response as? HTTPURLResponse)?.statusCode==200,
      let object=try JSONSerialization.jsonObject(with:data) as? [String:Any],let result=object["result"] as? String else {throw CheckoutError.message("Official Arc validator lookup failed")}
    return result
  }
  private func post(_ path:String, data:Data) async throws -> ServerState {
    var request=URLRequest(url:try url(path)); request.httpMethod="POST"; request.httpBody=data; request.timeoutInterval=15
    request.setValue("application/json",forHTTPHeaderField:"Content-Type")
    let (result,response)=try await URLSession.shared.data(for:request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw CheckoutError.message(String(data:result,encoding:.utf8) ?? "Matcher rejected intent") }
    return try JSONDecoder().decode(ServerState.self,from:result)
  }
  func refreshConfig() async throws {
    let latest:Config=try await get("/api/config",as:Config.self)
    guard latest.mode=="delayed-escrow",latest.chain==5042002 else { throw CheckoutError.message("Wrong checkout network") }
    guard let snapshot=latest.validatorSnapshot,snapshot.chain==latest.chain,snapshot.from>0,
      snapshot.to>=snapshot.from,snapshot.to-snapshot.from<=1800 else {throw CheckoutError.message("Matcher supplied no valid Arc validator checkpoint")}
    let raw=try await officialValidatorCall(height:snapshot.from-1)
    let decoded=try await CryptoBridge.shared.validatorSnapshot(raw,from:snapshot.from,to:snapshot.to)
    let official=try JSONDecoder().decode(ValidatorSnapshot.self,from:Data(decoded.utf8))
    guard snapshot==official else {throw CheckoutError.message("Validator checkpoint differs from official Arc RPC")}
    config=latest; UserDefaults.standard.set(try JSONEncoder().encode(latest),forKey:"config")
  }
  func refreshBalance() async {
    guard !address.isEmpty else { return }
    do {
      struct Balance:Decodable { let balance:String }
      let result:Balance=try await get("/api/balance/\(address)",as:Balance.self)
      balance=result.balance;UserDefaults.standard.set(result.balance,forKey:"escrowBalance")
      if let hex=try? await rpc("eth_getBalance",[address,"latest"]) {walletBalance=Self.decimalHex(hex)}
    } catch { /* Cached balance remains visible offline. */ }
    do {
      struct Balance:Decodable {let balance:String}
      let result:Balance=try await get("/api/legacy-balance/\(address)",as:Balance.self)
      legacyBalance=result.balance
    } catch { /* Old escrow remains visible after a successful refresh. */ }
  }
  var balanceUSDC: String { Self.units(balance) }
  var reserved: Decimal {
    orders.filter { $0.receive.contract.lowercased()==config?.contract.lowercased() && !["settled","expired"].contains($0.status) }.reduce(Decimal.zero) { $0 + (Decimal(string:$1.send.amount) ?? 0) }
  }
  static func decimalHex(_ hex:String) -> String {
    var total=Decimal.zero
    for character in hex.dropFirst(2) {if let digit=character.hexDigitValue {total=total*16+Decimal(digit)}}
    return NSDecimalNumber(decimal:total).stringValue
  }
  static func units(_ raw:String) -> String {
    guard let value=Decimal(string:raw) else { return "0.00" }
    let divisor=Decimal(string:"1000000000000000000")!
    return NSDecimalNumber(decimal:value/divisor).stringValue
  }
  static func money(_ raw:String) -> String {
    guard let n=Double(units(raw)) else { return "0.00" }
    return String(format:"%.2f",n)
  }
  func scan(_ raw:String) async {
    do {
      guard let config else { throw CheckoutError.message("Connect to matcher once to cache checkout settings") }
      if let envelope=try? JSONDecoder().decode(ProofEnvelope.self,from:Data(raw.utf8)),envelope.kind=="settlement-proof" {
        guard let index=orders.firstIndex(where:{$0.id==envelope.id}),let snapshot=config.validatorSnapshot else {throw CheckoutError.message("No signed payment or trusted validator cache for this proof")}
        let receive=String(data:try JSONEncoder().encode(orders[index].receive),encoding:.utf8)!
        let send=String(data:try JSONEncoder().encode(orders[index].send),encoding:.utf8)!
        let validators=String(data:try JSONEncoder().encode(snapshot),encoding:.utf8)!
        _ = try await CryptoBridge.shared.verifyProof(raw,receive:receive,send:send,snapshot:validators)
        orders[index].status="settled";orders[index].proofJSON=raw;orders[index].txHash=envelope.txHash
        persist();selectedOrderID=envelope.id;screen = .proof;showingScanner=false;message="Arc settlement proof verified offline"
        return
      }
      let verified=try await CryptoBridge.shared.verifyReceive(raw,contract:config.contract)
      let receive=try JSONDecoder().decode(ReceiveIntent.self,from:Data(verified.utf8))
      guard !orders.contains(where:{$0.id==receive.id}) else { throw CheckoutError.message("Already signed this invoice") }
      pendingReceive=receive;screen = .confirm;showingScanner=false;message=nil
    } catch { showingScanner=false;message=error.localizedDescription }
  }
  func authorize() async {
    guard let receive=pendingReceive, let config else { return }
    busy=true;defer { busy=false }
    do {
      guard let key=SecureWallet.read() else { throw CheckoutError.message("Wallet missing") }
      let amount=Decimal(string:receive.amount) ?? 0
      let available=(Decimal(string:balance) ?? 0)-reserved
      guard available>=amount else { throw CheckoutError.message("Prepay enough Arc escrow funds before signing this invoice") }
      let json=String(data:try JSONEncoder().encode(receive),encoding:.utf8)!
      let signed=try await CryptoBridge.shared.sign(json,key:key,contract:config.contract)
      let send=try JSONDecoder().decode(SendIntent.self,from:Data(signed.utf8))
      orders.insert(Order(receive:receive,send:send,status:"local",uploaded:false,txHash:nil,proofJSON:nil,error:nil,created:Date()),at:0)
      persist();selectedOrderID=send.id;screen = .proof;message=nil
      busy=false; await sync()
    } catch { message=error.localizedDescription }
  }
  func sync() async {
    if busy { return }; busy=true;defer { busy=false }
    for index in orders.indices {
      do {
        if orders[index].receive.contract.lowercased() != config?.contract.lowercased() {continue}
        let send=orders[index].send
        if !orders[index].uploaded && send.deadline < Int(Date().timeIntervalSince1970) { orders[index].status="expired"; continue }
        let state:ServerState
        if orders[index].status == "settled" {
          state=try await get("/api/status/\(send.vendor)/\(send.id)",as:ServerState.self)
        } else {
          let package=PaymentPackage(v:2,kind:"payment",receive:orders[index].receive,send:send)
          state=try await post("/api/package",data:JSONEncoder().encode(package));orders[index].uploaded=true
        }
        if orders[index].proofJSON == nil || state.status == "settled" {orders[index].status=state.status}
        orders[index].txHash=state.txHash ?? orders[index].txHash;orders[index].error=state.error
        if state.status == "settled" && orders[index].proofJSON == nil {
          orders[index].proofJSON=try? await getRaw("/api/settlement-proof/\(send.vendor)/\(send.id)")
        }
      } catch { orders[index].error=error.localizedDescription }
    }
    persist();await refreshBalance()
  }
  private func rpc(_ method:String, _ params:[String]) async throws -> String {
    guard let endpoint=URL(string:config?.rpc ?? "https://rpc.testnet.arc.io") else {throw CheckoutError.message("Arc RPC unavailable")}
    var request=URLRequest(url:endpoint);request.httpMethod="POST";request.timeoutInterval=20
    request.setValue("application/json",forHTTPHeaderField:"Content-Type")
    request.httpBody=try JSONSerialization.data(withJSONObject:["jsonrpc":"2.0","id":1,"method":method,"params":params])
    let (data,_)=try await URLSession.shared.data(for:request)
    guard let object=try JSONSerialization.jsonObject(with:data) as? [String:Any],let result=object["result"] as? String else { throw CheckoutError.message("Arc RPC rejected transaction: " + (String(data:data,encoding:.utf8) ?? "unknown error")) }
    return result
  }
  private func waitForArc(_ hash:String) async throws {
    for _ in 0..<30 {
      var request=URLRequest(url:URL(string:"https://rpc.testnet.arc.io")!)
      request.httpMethod="POST";request.timeoutInterval=15
      request.setValue("application/json",forHTTPHeaderField:"Content-Type")
      request.httpBody=try JSONSerialization.data(withJSONObject:["jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":[hash]])
      let (data,_)=try await URLSession.shared.data(for:request)
      if let object=try JSONSerialization.jsonObject(with:data) as? [String:Any],
         let receipt=object["result"] as? [String:Any] {
        guard receipt["status"] as? String == "0x1" else {throw CheckoutError.message("Arc transaction failed: " + String(hash.prefix(14)))}
        return
      }
      try await Task.sleep(for:.seconds(1))
    }
    throw CheckoutError.message("Arc confirmation timed out. Refresh balances before trying again.")
  }
  func deposit(_ text:String) async {
    guard let config else {message="Connect to matcher first";return}
    guard let amount=Decimal(string:text),amount>0 else {message="Enter an amount";return}
    busy=true;defer{busy=false}
    do {
      let scaled=amount * Decimal(string:"1000000000000000000")!
      let integer=NSDecimalNumber(decimal:scaled).stringValue
      guard !integer.contains("."),!integer.contains("E") else {throw CheckoutError.message("Use at most 18 decimal places")}
      guard let key=SecureWallet.read() else {throw CheckoutError.message("Wallet missing")}
      let nonce=try await rpc("eth_getTransactionCount",[address,"pending"])
      let price=try await rpc("eth_gasPrice",[])
      let raw=try await CryptoBridge.shared.signDeposit(key:key,contract:config.contract,amount:integer,nonce:nonce,gasPrice:price)
      let hash=try await rpc("eth_sendRawTransaction",[raw])
      message="Deposit submitted to Arc: " + String(hash.prefix(14)) + "… Refresh balance shortly."
      Task {try? await Task.sleep(for:.seconds(10));await refreshBalance()}
    } catch {message=error.localizedDescription}
  }
  func withdrawLegacy() async {
    let old="0x38929cCE8c5914755587d41Bf78B9ccC401AAc4d"
    guard let amount=Decimal(string:legacyBalance),amount>0 else {message="No funds in the old escrow";return}
    busy=true;defer{busy=false}
    do {
      guard let key=SecureWallet.read() else {throw CheckoutError.message("Wallet missing")}
      let nonce=try await rpc("eth_getTransactionCount",[address,"pending"])
      let price=try await rpc("eth_gasPrice",[])
      let raw=try await CryptoBridge.shared.signWithdraw(key:key,contract:old,amount:legacyBalance,nonce:nonce,gasPrice:price)
      let hash=try await rpc("eth_sendRawTransaction",[raw])
      message="Old escrow withdrawal submitted: " + String(hash.prefix(14)) + "… After it confirms, deposit those funds into the new escrow."
      Task {try? await Task.sleep(for:.seconds(10));await refreshBalance()}
    } catch {message=error.localizedDescription}
  }
  func migrateLegacy() async {
    guard let config,let amount=Decimal(string:legacyBalance),amount>0 else {message="No previous escrow funds to move";return}
    let amountRaw=legacyBalance,old="0x38929cCE8c5914755587d41Bf78B9ccC401AAc4d"
    busy=true;defer{busy=false}
    var stage="starting"
    do {
      guard let key=SecureWallet.read() else {throw CheckoutError.message("Wallet missing")}
      let nonce=try await rpc("eth_getTransactionCount",[address,"pending"])
      let price=try await rpc("eth_gasPrice",[])
      let withdrawal=try await CryptoBridge.shared.signWithdraw(key:key,contract:old,amount:amountRaw,nonce:nonce,gasPrice:price)
      let withdrawalHash=try await rpc("eth_sendRawTransaction",[withdrawal])
      stage="withdrawal submitted"
      try await waitForArc(withdrawalHash)
      stage="withdrawn"
      await refreshBalance()
      let nextNonce=try await rpc("eth_getTransactionCount",[address,"pending"])
      let nextPrice=try await rpc("eth_gasPrice",[])
      let deposit=try await CryptoBridge.shared.signDeposit(key:key,contract:config.contract,amount:amountRaw,nonce:nextNonce,gasPrice:nextPrice)
      let depositHash=try await rpc("eth_sendRawTransaction",[deposit])
      stage="deposit submitted"
      try await waitForArc(depositHash)
      await refreshBalance()
      message="Moved " + Self.money(amountRaw) + " USDC into the new Arc escrow."
    } catch {
      await refreshBalance()
      switch stage {
      case "deposit submitted":message="Deposit was submitted. Check both balances before retrying. " + error.localizedDescription
      case "withdrawn":message="Old funds are in your wallet. Deposit them into the new escrow in Settings. " + error.localizedDescription
      case "withdrawal submitted":message="Withdrawal was submitted. Check the old escrow and wallet balances before retrying. " + error.localizedDescription
      default:message=error.localizedDescription
      }
    }
  }
  func importKey(_ key:String) async {
    guard orders.isEmpty else { message="Use a fresh app install to switch wallets with queued payments";return }
    do {
      let trimmed=key.trimmingCharacters(in:.whitespacesAndNewlines)
      guard trimmed.range(of:"^0x[0-9a-fA-F]{64}$",options:.regularExpression) != nil else { throw CheckoutError.message("Enter a 32-byte 0x private key") }
      let newAddress=try await CryptoBridge.shared.address(key:trimmed)
      try SecureWallet.save(trimmed);address=newAddress;balance="0";UserDefaults.standard.removeObject(forKey:"escrowBalance")
      showingImport=false;await refreshBalance()
    } catch { message=error.localizedDescription }
  }
  private func persist() { UserDefaults.standard.set(try? JSONEncoder().encode(orders),forKey:"orders") }
}
