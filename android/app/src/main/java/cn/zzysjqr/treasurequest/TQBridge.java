package cn.zzysjqr.treasurequest;

import android.util.Log;
import android.webkit.JavascriptInterface;

/**
 * JS ↔ Java 桥。注册名 {@code TQNative}（契约见 docs/OTA.md 3.3）。
 *
 * <p>注意：{@code @JavascriptInterface} 方法运行在 WebView 的 JavaBridge 线程，不是主线程；
 * 涉及 UI/WebView 的操作（restartApp/openExternal）必须切回主线程。
 * getState()/getLogInfo() 只读内存快照，不阻塞桥线程。
 */
public class TQBridge {

    private static final String TAG = "TQ.Bridge";

    private final MainActivity activity;
    private final OtaManager otaManager;

    public TQBridge(MainActivity activity, OtaManager otaManager) {
        this.activity = activity;
        this.otaManager = otaManager;
    }

    /** 立即返回运行状态 JSON（字段见 docs/OTA.md 3.3）。 */
    @JavascriptInterface
    public String getState() {
        if (otaManager == null) {
            return "{}";
        }
        return otaManager.getStateJson();
    }

    /** 异步检查更新；结果通过 ota_* 事件回调。 */
    @JavascriptInterface
    public void checkUpdate() {
        if (otaManager == null) {
            Log.w(TAG, "checkUpdate ignored: otaManager is null");
            return;
        }
        otaManager.checkUpdate(false);
    }

    /** 下载并安装当前可用更新；进度通过 ota_progress 事件回调。 */
    @JavascriptInterface
    public void downloadUpdate() {
        if (otaManager == null) {
            Log.w(TAG, "downloadUpdate ignored: otaManager is null");
            return;
        }
        otaManager.downloadUpdate();
    }

    /** 重启 WebView，让新内容生效。 */
    @JavascriptInterface
    public void restartApp() {
        final MainActivity target = activity;
        if (target == null) {
            return;
        }
        target.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                target.restartWebView();
            }
        });
    }

    /** 用系统浏览器打开链接（APK 下载/更新说明等）。 */
    @JavascriptInterface
    public void openExternal(final String url) {
        final MainActivity target = activity;
        if (target == null) {
            return;
        }
        target.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                target.openExternalUrl(url);
            }
        });
    }

    /** 调试用：当前内容版本/目录/内置版本等。 */
    @JavascriptInterface
    public String getLogInfo() {
        if (otaManager == null) {
            return "otaManager=null";
        }
        return otaManager.getLogInfo();
    }
}
