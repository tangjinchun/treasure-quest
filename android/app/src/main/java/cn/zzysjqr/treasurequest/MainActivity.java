package cn.zzysjqr.treasurequest;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * 《寻宝奇兵》Android WebView 壳入口。
 *
 * <p>职责：
 * <ul>
 *   <li>代码构建 FrameLayout + WebView + ProgressBar（不依赖复杂布局 XML）；</li>
 *   <li>WebView 安全设置（JS / DOM storage 开，file access / mixed content 关，音效不需用户手势）；</li>
 *   <li>加载 {@code https://app.local/index.html}，由 {@link BundleWebViewClient} 从生效内容目录供给；</li>
 *   <li>注册 {@link TQBridge}（TQNative），承载 OTA 状态机与原生事件回调；</li>
 *   <li>生命周期：onPause/onResume 通知 JS、返回键交给 JS、冷启动 3s 后静默检查更新；</li>
 *   <li>内容加载失败时回退上一版本/内置 assets 并 reload。</li>
 * </ul>
 *
 * <p>纯 Java 8 语法；零 AndroidX、零第三方依赖。
 */
public class MainActivity extends Activity implements OtaManager.EventSink, BundleWebViewClient.Listener {

    private static final String TAG = "TQ.Main";

    private FrameLayout root;
    private WebView webView;
    private ProgressBar loadingBar;
    private TextView errorView;
    private OtaManager otaManager;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    /** 同一次主文档加载失败只处理一次（避免 onReceivedError/onReceivedHttpError 双回调重复回退）。 */
    private boolean fallbackScheduled = false;

    /** 冷启动 3 秒后静默检查更新：有新版只通知 JS（设置页红点），不自动下载。 */
    private final Runnable silentCheckRunnable = new Runnable() {
        @Override
        public void run() {
            if (isFinishing() || otaManager == null) {
                return;
            }
            Log.i(TAG, "cold start: silent update check");
            otaManager.checkUpdate(true);
        }
    };

    /**
     * 白屏兜底看门狗：页面加载/渲染异常时（例如内容包损坏、WebView 未触发错误回调），
     * 12s 后探测 DOM 是否有可见文本；为空则触发内容回退或展示原生错误页。
     */
    private final Runnable loadWatchdogRunnable = new Runnable() {
        @Override
        public void run() {
            final WebView view = webView;
            if (view == null || isFinishing()) {
                return;
            }
            try {
                view.evaluateJavascript(
                        "(function(){try{var b=document.body;if(!b)return 'empty';"
                                + "var t=String(b.innerText||b.textContent||'').replace(/\\s+/g,'');"
                                + "return (b.children.length>0&&t.length>0)?'ok':'empty';}catch(e){return 'empty';}})()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                if (!isFinishing() && !"\"ok\"".equals(value)) {
                                    Log.w(TAG, "load watchdog: page looks empty, value=" + value);
                                    onWatchdogLoadFailure();
                                }
                            }
                        });
            } catch (RuntimeException e) {
                Log.w(TAG, "load watchdog evaluate failed", e);
            }
        }
    };

    // ==================================================================
    // 生命周期
    // ==================================================================

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);

        // 测试构建：在创建 WebView 之前开启远程调试（CDP），供模拟器/真机自动化验证 OTA。
        // 当前 Manifest 未声明 android:debuggable，FLAG_DEBUGGABLE 为 false，
        // 因此由 AppConfig.ENABLE_WEBVIEW_REMOTE_DEBUG 兜底开启；正式发布前改 false。
        enableWebViewRemoteDebugging();

        buildViews();
        otaManager = new OtaManager(this, this);
        otaManager.initialize();
        setupWebView();
        loadMainPage();

        mainHandler.postDelayed(silentCheckRunnable, AppConfig.SILENT_CHECK_DELAY_MS);
    }

    /**
     * 开启 WebView 远程调试（Chrome DevTools Protocol），必须在创建 WebView 之前调用。
     *
     * <p>判定：测试构建由 {@link AppConfig#ENABLE_WEBVIEW_REMOTE_DEBUG} 无条件开启；
     * 若 APK 在 Manifest 声明 {@code android:debuggable="true"}，FLAG_DEBUGGABLE 也会自动开启。
     * 正式发布前把该常量改为 false（仅保留 debuggable 判断）。
     */
    private void enableWebViewRemoteDebugging() {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!AppConfig.ENABLE_WEBVIEW_REMOTE_DEBUG && !debuggable) {
            return;
        }
        try {
            WebView.setWebContentsDebuggingEnabled(true);
            Log.i(TAG, "WebView remote debugging enabled (debuggable=" + debuggable + ")");
        } catch (RuntimeException e) {
            Log.w(TAG, "enable WebView remote debugging failed", e);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemUi();
        if (webView != null) {
            webView.onResume();
        }
        evaluateJs("(function(){if(window.TQ&&window.TQ.Shell&&typeof window.TQ.Shell.onResume==='function')"
                + "{try{window.TQ.Shell.onResume();}catch(e){}}})();");
    }

    @Override
    protected void onPause() {
        evaluateJs("(function(){if(window.TQ&&window.TQ.Shell&&typeof window.TQ.Shell.onPause==='function')"
                + "{try{window.TQ.Shell.onPause();}catch(e){}}})();");
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
        if (otaManager != null) {
            otaManager.shutdown();
            otaManager = null;
        }
        if (webView != null) {
            if (root != null) {
                root.removeView(webView);
            }
            webView.stopLoading();
            webView.removeJavascriptInterface(AppConfig.JS_BRIDGE_NAME);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUi();
        }
    }

    /**
     * 返回键优先交给 H5：{@code window.TQ.Shell.onAndroidBack()} 返回 true 表示页面已消费；
     * 否则执行默认返回（退出应用）。契约见 docs/OTA.md 3.5 / task-3。
     */
    @Override
    public void onBackPressed() {
        final WebView view = webView;
        if (view == null) {
            performDefaultBack();
            return;
        }
        view.evaluateJavascript(
                "(function(){try{if(window.TQ&&window.TQ.Shell&&typeof window.TQ.Shell.onAndroidBack==='function')"
                        + "{return window.TQ.Shell.onAndroidBack()===true;}}catch(e){}return false;})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"true".equals(value)) {
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    performDefaultBack();
                                }
                            });
                        }
                    }
                });
    }

    private void performDefaultBack() {
        if (isFinishing()) {
            return;
        }
        super.onBackPressed();
    }

    // ==================================================================
    // 视图构建（代码构建，不用布局 XML）
    // ==================================================================

    private void buildViews() {
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(Color.BLACK);

        webView = new WebView(this);
        container.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        loadingBar = new ProgressBar(this);
        loadingBar.setIndeterminate(true);
        FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        container.addView(loadingBar, barParams);

        errorView = new TextView(this);
        errorView.setTextColor(Color.WHITE);
        errorView.setTextSize(18f);
        errorView.setGravity(Gravity.CENTER);
        errorView.setPadding(48, 48, 48, 48);
        errorView.setVisibility(View.GONE);
        errorView.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loadMainPage();
            }
        });
        container.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root = container;
        setContentView(root);
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        // 音效/背景音乐由游戏 JS 控制，不要求用户手势（否则自动播放会被拦）。
        settings.setMediaPlaybackRequiresUserGesture(false);
        // 全部走 HTTPS + app.local 拦截，禁止混合内容。
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUserAgentString(settings.getUserAgentString()
                + " TreasureQuestShell/" + AppConfig.APP_VERSION_NAME);

        webView.setBackgroundColor(Color.BLACK);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setWebViewClient(new BundleWebViewClient(this, otaManager, this));
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (loadingBar == null) {
                    return;
                }
                if (newProgress >= 100) {
                    loadingBar.setVisibility(View.GONE);
                    fallbackScheduled = false;
                } else {
                    loadingBar.setVisibility(View.VISIBLE);
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                if (consoleMessage != null) {
                    Log.d(TAG + ".console", consoleMessage.message() + " ("
                            + consoleMessage.sourceId() + ":" + consoleMessage.lineNumber() + ")");
                }
                return true;
            }
        });
        webView.addJavascriptInterface(new TQBridge(this, otaManager), AppConfig.JS_BRIDGE_NAME);
    }

    private void loadMainPage() {
        loadPageUrl();
    }

    /** 从虚拟域名加载入口页；响应由 BundleWebViewClient 从生效内容目录/内置 assets 供给。 */
    private void loadPageUrl() {
        if (webView == null) {
            return;
        }
        fallbackScheduled = false;
        if (loadingBar != null) {
            loadingBar.setVisibility(View.VISIBLE);
        }
        if (errorView != null) {
            errorView.setVisibility(View.GONE);
        }
        // 每次加载都重置白屏看门狗（加载成功也只在 12s 后探测一次 DOM，无副作用）。
        mainHandler.removeCallbacks(loadWatchdogRunnable);
        mainHandler.postDelayed(loadWatchdogRunnable, AppConfig.LOAD_WATCHDOG_MS);
        webView.loadUrl(AppConfig.PAGE_URL);
    }

    // ==================================================================
    // 供 TQBridge / BundleWebViewClient 调用
    // ==================================================================

    /** 重启 WebView：应用已下载内容（若有）→ clearCache(true) → reload（契约 3.4）。 */
    public void restartWebView() {
        if (otaManager != null) {
            otaManager.activatePendingContent();
        }
        if (webView == null) {
            return;
        }
        Log.i(TAG, "restart webview, contentVersion="
                + (otaManager != null ? otaManager.getContentVersion() : -1));
        if (loadingBar != null) {
            loadingBar.setVisibility(View.VISIBLE);
        }
        if (errorView != null) {
            errorView.setVisibility(View.GONE);
        }
        webView.stopLoading();
        webView.clearCache(true);
        webView.clearHistory();
        loadPageUrl();
    }

    /** 用系统浏览器打开 http(s) 链接（桥方法 openExternal / WebView 外链统一入口）。 */
    public void openExternalUrl(String url) {
        if (url == null) {
            return;
        }
        String target = url.trim();
        if (!isHttpUrl(target)) {
            Log.w(TAG, "openExternal blocked non-http(s) url: " + target);
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(target));
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "未找到可打开该链接的应用", Toast.LENGTH_SHORT).show();
        } catch (SecurityException e) {
            Log.w(TAG, "openExternal denied: " + target, e);
            Toast.makeText(this, "无法打开该链接", Toast.LENGTH_SHORT).show();
        }
    }

    // ==================================================================
    // BundleWebViewClient.Listener：加载失败回退 / 外链
    // ==================================================================

    @Override
    public void onMainFrameLoadError(WebView view, int errorCode, String description, String failingUrl) {
        Log.w(TAG, "main frame load error: " + errorCode + " " + description + " " + failingUrl);
        if (fallbackScheduled) {
            // 同一次加载失败可能触发两个回调；回退 reload 已安排，忽略重复回调。
            return;
        }
        if (!isEntryUrl(failingUrl)) {
            // 非入口页失败（例如游戏内跳转到不存在页面）：不删内容目录，只提示错误。
            Log.w(TAG, "non-entry page failed, keep content untouched: " + failingUrl);
            showFatalError(description);
            return;
        }
        if (otaManager == null) {
            showFatalError(description);
            return;
        }
        boolean fellBack = otaManager.handleContentLoadFailure();
        if (!fellBack) {
            // 当前已是内置 assets，说明内置内容也加载失败：给用户重试入口。
            showFatalError(description);
            return;
        }
        fallbackScheduled = true;
        Log.w(TAG, "content load failed, fallback applied, reload after 300ms");
        // 延迟少许 reload，避开同一次失败的第二回调；reload 后 fallbackScheduled 复位。
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                loadPageUrl();
            }
        }, 300L);
    }

    @Override
    public void onExternalLink(String url) {
        openExternalUrl(url);
    }

    /** 看门狗发现页面为空：优先回退内容，否则展示原生错误页（复用 errorView，点击重试）。 */
    private void onWatchdogLoadFailure() {
        if (fallbackScheduled) {
            return;
        }
        if (otaManager != null && otaManager.handleContentLoadFailure()) {
            fallbackScheduled = true;
            Log.w(TAG, "watchdog: content fallback applied, reload after 300ms");
            mainHandler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    loadPageUrl();
                }
            }, 300L);
            return;
        }
        showFatalError("页面加载超时或内容为空");
    }

    // ==================================================================
    // OtaManager.EventSink：原生事件 → window.TQNativeEvent(type, payload)
    // ==================================================================

    @Override
    public void dispatchNativeEvent(final String type, final JSONObject payload) {
        final WebView view = webView;
        if (view == null) {
            return;
        }
        String jsonText = payload != null ? payload.toString() : "{}";
        // JSON 作为 JS 对象字面量注入：转义 U+2028/U+2029（JS 行终止符，JSON 允许但旧 JS 引擎会报错）。
        String safeJson = jsonText.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        String script = "window." + AppConfig.JS_EVENT_FN + " && " + AppConfig.JS_EVENT_FN
                + "(" + JSONObject.quote(type) + ", " + safeJson + ");";
        try {
            view.evaluateJavascript(script, null);
        } catch (RuntimeException e) {
            Log.w(TAG, "evaluateJavascript failed: " + type, e);
        }
    }

    // ==================================================================
    // 内部工具
    // ==================================================================

    private void showFatalError(String description) {
        if (errorView != null) {
            String message = "内容加载失败，请检查网络后点击重试";
            if (description != null && description.length() > 0) {
                message = message + "\n(" + description + ")";
            }
            errorView.setText(message);
            errorView.setVisibility(View.VISIBLE);
        }
        if (loadingBar != null) {
            loadingBar.setVisibility(View.GONE);
        }
    }

    private void evaluateJs(String script) {
        WebView view = webView;
        if (view == null) {
            return;
        }
        try {
            view.evaluateJavascript(script, null);
        } catch (RuntimeException e) {
            Log.w(TAG, "evaluateJavascript failed", e);
        }
    }

    private void hideSystemUi() {
        View decorView = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            // Android 11+（含 targetSdk 35 的 Android 15 edge-to-edge）：用 WindowInsetsController。
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            // Android 8.0–10：兼容旧沉浸式全屏标志。
            decorView.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    private static boolean isHttpUrl(String url) {
        try {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
                return false;
            }
            String host = uri.getHost();
            return host != null && host.length() > 0;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** 是否是 H5 入口页（https://app.local/index.html 或 /）；只有入口页失败才触发内容回退。 */
    private static boolean isEntryUrl(String failingUrl) {
        if (failingUrl == null || failingUrl.length() == 0) {
            return true;
        }
        try {
            Uri uri = Uri.parse(failingUrl);
            String host = uri.getHost();
            if (!AppConfig.PAGE_HOST.equalsIgnoreCase(host)) {
                return false;
            }
            String path = uri.getPath();
            if (path == null || path.length() == 0 || "/".equals(path)) {
                return true;
            }
            return ("/" + AppConfig.INDEX_FILE).equals(path);
        } catch (RuntimeException e) {
            return false;
        }
    }
}
