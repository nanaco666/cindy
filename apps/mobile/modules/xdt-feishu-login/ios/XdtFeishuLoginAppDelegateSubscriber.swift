import ExpoModulesCore
import LarkSSOSDK

public class XdtFeishuLoginAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return LarkSSO.handleURL(url)
  }
}
