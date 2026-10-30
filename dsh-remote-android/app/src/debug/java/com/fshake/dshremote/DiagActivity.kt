package com.fshake.dshremote

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import com.fshake.dshremote.web.WebCompat

/**
 * 仅存在于 debug 包的视口自检页。
 *
 * 目的：在不需要登录的情况下，量出这台设备上 WebView 的 100vh 与视口尺寸，
 * 用来判断「整页高度塌成 0」是引擎/设备问题还是页面问题。
 */
class DiagActivity : Activity() {

    private lateinit var webView: WebView
    private var phase = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(true)

        webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        // 用与正式代码相同的注入脚本，验证它不会破坏正常页面的渲染
        WebViewCompat.addDocumentStartJavaScript(webView, WebCompat.documentStartScript, setOf("*"))
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                view.postDelayed({ measure(view, url) }, 400)
            }
        }
        setContentView(webView)
        webView.loadDataWithBaseURL(null, BLANK_PAGE, "text/html", "utf-8", null)
    }

    private fun measure(view: WebView, url: String) {
        view.evaluateJavascript(PROBE) { result ->
            Log.i(TAG, "phase=$phase url=$url size=${view.width}x${view.height} density=${resources.displayMetrics.density} result=$result")
            if (phase == 0) {
                phase = 1
                view.loadUrl("https://dsn.example.com/")
            }
        }
    }

    companion object {
        private const val TAG = "DshDiag"

        private const val BLANK_PAGE = """
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0"><div style="height:100vh;background:#333"></div></body></html>
"""

        private const val PROBE = """
(function () {
  try {
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:100vh';
    document.body.appendChild(d);
    var vh = d.offsetHeight;
    d.parentNode.removeChild(d);
    var d2 = document.createElement('div');
    d2.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:50%';
    document.body.appendChild(d2);
    var pct = d2.offsetHeight;
    d2.parentNode.removeChild(d2);
    return JSON.stringify({
      vh: vh, pct50: pct,
      innerH: window.innerHeight, innerW: window.innerWidth,
      visualH: window.visualViewport ? Math.round(window.visualViewport.height) : -1,
      htmlClientH: document.documentElement.clientHeight,
      htmlStyleH: getComputedStyle(document.documentElement).height,
      bodyClientH: document.body ? document.body.clientHeight : -1,
      bodyStyleH: document.body ? getComputedStyle(document.body).height : '',
      dpr: window.devicePixelRatio,
      compat: document.compatMode
    });
  } catch (e) { return 'probe-error:' + e; }
})();
"""
    }
}
