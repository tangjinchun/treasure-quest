package cn.zzysjqr.treasurequest;

import android.content.Context;
import android.content.res.AssetManager;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 拦截 {@code https://app.local/*}，从「生效内容目录」读取页面资源（契约见 docs/OTA.md 3.4）。
 *
 * <p>规则：
 * <ul>
 *   <li>host 必须是 {@code app.local}，其它域名放行（CDN / 接口走真实网络）；</li>
 *   <li>生效目录 = 已下载内容目录（files/web/&lt;version&gt;/）；无下载内容时读 assets/web/；</li>
 *   <li>拒绝 {@code ..}、反斜杠、绝对路径、盘符等路径；用 canonical path 做最终越界校验；</li>
 *   <li>按扩展名返回 MIME，响应头固定 {@code Cache-Control: no-cache}；</li>
 *   <li>找不到文件返回 404（不会回退去读其它目录或服务器）。</li>
 * </ul>
 */
public class BundleWebViewClient extends WebViewClient {

    private static final String TAG = "TQ.BundleClient";
    /** 单个资源文件大小保护上限（整个内容包上限 20MB，单文件不会超过它）。 */
    private static final long MAX_FILE_BYTES = AppConfig.MAX_BUNDLE_BYTES;

    /** 生效内容目录提供者（由 OtaManager 实现）。 */
    public interface ContentProvider {
        /**
         * @return 当前生效的已下载内容目录；返回 null 表示使用 APK 内置 assets/web。
         */
        File getActiveContentDir();

        /**
         * @return 当前生效内容版本（调试/日志用）。
         */
        int getContentVersion();
    }

    /** 供 MainActivity 处理主文档加载失败回退、外链跳转。 */
    public interface Listener {
        void onMainFrameLoadError(WebView view, int errorCode, String description, String failingUrl);

        void onExternalLink(String url);
    }

    private final AssetManager assetManager;
    private final ContentProvider contentProvider;
    private final Listener listener;

    public BundleWebViewClient(Context context, ContentProvider contentProvider, Listener listener) {
        this.assetManager = context.getApplicationContext().getAssets();
        this.contentProvider = contentProvider;
        this.listener = listener;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (request == null) {
            return null;
        }
        Uri uri = request.getUrl();
        if (uri == null || uri.getHost() == null) {
            return null;
        }
        if (!AppConfig.PAGE_HOST.equalsIgnoreCase(uri.getHost())) {
            // 非 app.local：交给网络栈（接口 / CDN / 外链下载）。
            return null;
        }

        String method = request.getMethod();
        if (!"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method)) {
            return new WebResourceResponse("text/plain", "UTF-8", 405, "Method Not Allowed",
                    noCacheHeaders(), new ByteArrayInputStream(new byte[0]));
        }

        String relativePath = toSafeRelativePath(uri.getPath());
        if (relativePath == null) {
            Log.w(TAG, "blocked illegal request path: " + uri);
            return notFound();
        }

        File activeDir = contentProvider == null ? null : contentProvider.getActiveContentDir();
        byte[] data;
        if (activeDir != null) {
            // 已下载内容生效时只读该目录；缺失文件返回 404，绝不混读 assets（契约 3.4）。
            data = readFileWithin(activeDir, relativePath);
        } else {
            // 没有可用下载内容：读取 APK 内置 assets/web。
            data = readAsset(relativePath);
        }
        if (data == null) {
            Log.w(TAG, "404 " + relativePath + " (active="
                    + (activeDir != null ? activeDir.getAbsolutePath() : "assets") + ")");
            return notFound();
        }
        return new WebResourceResponse(mimeTypeOf(relativePath), encodingOf(relativePath),
                200, "OK", noCacheHeaders(), new ByteArrayInputStream(data));
    }

    // ------------------------------------------------------------------
    // 链接处理：app.local 内部放行，其它 http(s) 交给系统浏览器
    // ------------------------------------------------------------------

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (request == null) {
            return false;
        }
        Uri uri = request.getUrl();
        if (uri == null) {
            return false;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if ("https".equalsIgnoreCase(scheme) && AppConfig.PAGE_HOST.equalsIgnoreCase(host)) {
            return false;
        }
        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
            Log.i(TAG, "external link: " + uri);
            if (listener != null) {
                listener.onExternalLink(uri.toString());
            }
            return true;
        }
        // intent://、mailto:、tel: 等一律拦截，避免 WebView 崩溃或跳转异常。
        Log.w(TAG, "blocked unsupported scheme: " + uri);
        return true;
    }

    // ------------------------------------------------------------------
    // 主文档加载失败 → 交给 MainActivity 触发内容回退
    // ------------------------------------------------------------------

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request == null || !request.isForMainFrame()) {
            return;
        }
        int errorCode = error != null ? error.getErrorCode() : -1;
        String description = error != null ? String.valueOf(error.getDescription()) : "unknown";
        String failingUrl = request.getUrl() != null ? request.getUrl().toString() : "";
        Log.e(TAG, "main frame load error: " + errorCode + " " + description + " " + failingUrl);
        if (listener != null) {
            listener.onMainFrameLoadError(view, errorCode, description, failingUrl);
        }
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        if (request == null || !request.isForMainFrame() || errorResponse == null) {
            return;
        }
        int statusCode = errorResponse.getStatusCode();
        if (statusCode < 400) {
            return;
        }
        String description = "HTTP " + statusCode
                + (errorResponse.getReasonPhrase() != null ? " " + errorResponse.getReasonPhrase() : "");
        String failingUrl = request.getUrl() != null ? request.getUrl().toString() : "";
        Log.e(TAG, "main frame http error: " + description + " " + failingUrl);
        if (listener != null) {
            listener.onMainFrameLoadError(view, statusCode, description, failingUrl);
        }
    }

    // ------------------------------------------------------------------
    // 路径安全与资源读取
    // ------------------------------------------------------------------

    /**
     * 把 URL path 规范化成生效目录内的相对路径；非法（可能穿越目录）返回 null。
     */
    private static String toSafeRelativePath(String path) {
        if (path == null) {
            return null;
        }
        if (path.indexOf('\\') >= 0 || path.indexOf('\u0000') >= 0 || path.indexOf(':') >= 0) {
            return null;
        }
        String work = path;
        while (work.startsWith("/")) {
            work = work.substring(1);
        }
        if (work.isEmpty()) {
            return AppConfig.INDEX_FILE;
        }
        if (work.endsWith("/")) {
            work = work + AppConfig.INDEX_FILE;
        }
        String[] segments = work.split("/", -1);
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < segments.length; i++) {
            String segment = segments[i];
            if (segment.isEmpty() || ".".equals(segment)) {
                continue;
            }
            if ("..".equals(segment)) {
                return null;
            }
            if (builder.length() > 0) {
                builder.append('/');
            }
            builder.append(segment);
        }
        String relative = builder.toString();
        if (relative.isEmpty()) {
            return AppConfig.INDEX_FILE;
        }
        return relative;
    }

    private static byte[] readFileWithin(File baseDir, String relativePath) {
        InputStream in = null;
        try {
            String basePath = baseDir.getCanonicalPath();
            File file = new File(baseDir, relativePath);
            String filePath = file.getCanonicalPath();
            // canonical path 最终校验：必须位于生效目录内（防 zip-slip / 符号链接逃逸）。
            if (!filePath.equals(basePath) && !filePath.startsWith(basePath + File.separator)) {
                Log.w(TAG, "path escapes content dir: " + relativePath);
                return null;
            }
            if (!file.isFile()) {
                return null;
            }
            if (file.length() > MAX_FILE_BYTES) {
                Log.w(TAG, "file too large, rejected: " + relativePath);
                return null;
            }
            in = new FileInputStream(file);
            return readFully(in);
        } catch (IOException e) {
            Log.w(TAG, "read content file failed: " + relativePath, e);
            return null;
        } catch (SecurityException e) {
            Log.w(TAG, "read content file denied: " + relativePath, e);
            return null;
        } finally {
            closeQuietly(in);
        }
    }

    private byte[] readAsset(String relativePath) {
        InputStream in = null;
        try {
            in = assetManager.open(AppConfig.ASSET_ROOT + "/" + relativePath);
            return readFully(in);
        } catch (IOException e) {
            return null;
        } finally {
            closeQuietly(in);
        }
    }

    private static byte[] readFully(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        long total = 0;
        int read;
        while ((read = in.read(buffer)) != -1) {
            total += read;
            if (total > MAX_FILE_BYTES) {
                Log.w(TAG, "resource exceeds size limit, rejected");
                return null;
            }
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }

    // ------------------------------------------------------------------
    // MIME / 响应头
    // ------------------------------------------------------------------

    private static String mimeTypeOf(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) {
            return "text/html";
        }
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
            return "application/javascript";
        }
        if (lower.endsWith(".css")) {
            return "text/css";
        }
        if (lower.endsWith(".json") || lower.endsWith(".map")) {
            return "application/json";
        }
        if (lower.endsWith(".png")) {
            return "image/png";
        }
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (lower.endsWith(".gif")) {
            return "image/gif";
        }
        if (lower.endsWith(".webp")) {
            return "image/webp";
        }
        if (lower.endsWith(".svg")) {
            return "image/svg+xml";
        }
        if (lower.endsWith(".ico")) {
            return "image/x-icon";
        }
        if (lower.endsWith(".woff2")) {
            return "font/woff2";
        }
        if (lower.endsWith(".woff")) {
            return "font/woff";
        }
        if (lower.endsWith(".ttf")) {
            return "font/ttf";
        }
        if (lower.endsWith(".otf")) {
            return "font/otf";
        }
        if (lower.endsWith(".mp3")) {
            return "audio/mpeg";
        }
        if (lower.endsWith(".ogg") || lower.endsWith(".oga")) {
            return "audio/ogg";
        }
        if (lower.endsWith(".wav")) {
            return "audio/wav";
        }
        if (lower.endsWith(".m4a")) {
            return "audio/mp4";
        }
        if (lower.endsWith(".txt")) {
            return "text/plain";
        }
        return "application/octet-stream";
    }

    private static String encodingOf(String path) {
        String mime = mimeTypeOf(path);
        if (mime.startsWith("text/")
                || "application/javascript".equals(mime)
                || "application/json".equals(mime)) {
            return "UTF-8";
        }
        return null;
    }

    private static Map<String, String> noCacheHeaders() {
        Map<String, String> headers = new HashMap<String, String>();
        // 契约 3.4：更新 reload 后必须拿到新文件，禁止使用缓存副本。
        headers.put("Cache-Control", "no-cache");
        return headers;
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                noCacheHeaders(), new ByteArrayInputStream(new byte[0]));
    }

    private static void closeQuietly(Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (IOException ignored) {
            // ignore
        }
    }
}
