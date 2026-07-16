package com.xdtmaker.feishulogin

import android.content.Intent
import android.net.Uri
import com.ss.android.larksso.CallBackData
import com.ss.android.larksso.IGetDataCallback
import com.ss.android.larksso.LarkSSO
import expo.modules.kotlin.events.OnActivityResultPayload
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise

class XdtFeishuLoginModule : Module() {
  private var pendingPromise: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("XdtFeishuLogin")

    AsyncFunction("isFeishuAppInstalled") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse("lark://ssoclient"))
      intent.resolveActivity(context.packageManager) != null
    }

    AsyncFunction("requestFeishuAuthCode") { options: Map<String, Any?>, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("ERR_FEISHU_NO_ACTIVITY", "No current Android activity.", null)
        return@AsyncFunction
      }
      val appId = options["appId"] as? String
      if (appId.isNullOrBlank()) {
        promise.reject("ERR_FEISHU_INVALID_APP_ID", "Missing Feishu appId.", null)
        return@AsyncFunction
      }
      if (pendingPromise != null) {
        promise.reject("ERR_FEISHU_IN_PROGRESS", "Feishu login is already in progress.", null)
        return@AsyncFunction
      }
      pendingPromise = promise
      val builder = LarkSSO.Builder()
        .setAppId(appId)
        .setServer("Feishu")
        .setChallengeMode(false)
        .setLanguage("zh")
        .setContext(activity)

      LarkSSO.inst().startSSOVerify(builder, object : IGetDataCallback {
        override fun onSuccess(callBackData: CallBackData) {
          val current = pendingPromise
          pendingPromise = null
          val code = callBackData.code
          if (code.isNullOrBlank()) {
            current?.reject("ERR_FEISHU_EMPTY_CODE", "Feishu Login SDK returned an empty code.", null)
          } else {
            current?.resolve(mapOf("code" to code))
          }
        }

        override fun onError(callBackData: CallBackData) {
          val current = pendingPromise
          pendingPromise = null
          current?.reject("ERR_FEISHU_LOGIN_FAILED", "Feishu Login SDK failed: ${callBackData.code}", null)
        }
      })
    }

    OnNewIntent { intent ->
      appContext.currentActivity?.let { activity ->
        LarkSSO.inst().parseIntent(activity, intent)
      }
    }

    OnActivityResult { activity, payload: OnActivityResultPayload ->
      // payload.data is nullable (e.g. user cancels authorization); LarkSSO.parseIntent
      // expects a non-null Intent, so guard against NPE before forwarding.
      payload.data?.let { LarkSSO.inst().parseIntent(activity, it) }
    }
  }
}
