import ExpoModulesCore
import LarkSSOSDK
import UIKit

public class XdtFeishuLoginModule: Module, LarkSSODelegate {
  private var pendingPromise: Promise?

  public func definition() -> ModuleDefinition {
    Name("XdtFeishuLogin")

    AsyncFunction("isFeishuAppInstalled") { () -> Bool in
      guard let url = URL(string: "lark://ssoclient") else {
        return false
      }
      return UIApplication.shared.canOpenURL(url)
    }

    AsyncFunction("requestFeishuAuthCode") { (options: [String: Any], promise: Promise) in
      guard let appId = options["appId"] as? String, !appId.isEmpty else {
        promise.reject("ERR_FEISHU_INVALID_APP_ID", "Missing Feishu appId.")
        return
      }
      if self.pendingPromise != nil {
        promise.reject("ERR_FEISHU_IN_PROGRESS", "Feishu login is already in progress.")
        return
      }
      self.pendingPromise = promise
      let scheme = appId.replacingOccurrences(of: "_", with: "")
      LarkSSO.register(apps: [
        App(server: .feishu, appId: appId, scheme: scheme)
      ])
      LarkSSO.setupLang("zh")
      LarkSSO.setupLog()

      var request: SSORequest = .feishu
      request.useChallengeCode = false
      // sendWithRequest:viewController:delegate: 的 viewController 是可空参数,仅用于 SDK 内部
      // 降级 H5 的呈现。我们只在已装飞书 App 时才调用本方法(JS 层 isFeishuAppInstalled 门控,
      // 走原生唤起),无飞书时走我们自己的系统浏览器兜底(openAuthSessionAsync),不依赖 SDK 的
      // H5 降级,故此处传 nil。
      LarkSSO.send(request: request, viewController: nil, delegate: self)
    }
  }

  public func didReceive(response: SSOResponse) {
    let promise = pendingPromise
    pendingPromise = nil
    response.safeHandleResult { code in
      promise?.resolve(["code": code])
    } failure: { error in
      promise?.reject("ERR_FEISHU_LOGIN_FAILED", String(describing: error))
    }
  }

  public func lkSSODidReceive(response: SSOResponse) {
    didReceive(response: response)
  }
}
