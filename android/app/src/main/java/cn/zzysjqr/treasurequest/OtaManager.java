package cn.zzysjqr.treasurequest;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 内容 OTA 管理器（Android 壳）。严格实现 docs/OTA.md 第 3.2 / 3.3 节状态机：
 *
 * <pre>
 * IDLE → CHECKING → UP_TO_DATE | AVAILABLE → DOWNLOADING(进度) → VERIFY(sha256) → UNZIP → READY(重启生效)
 *                                                          └─ 失败 → ERROR（保留当前版本）
 * </pre>
 *
 * <p>线程模型：{@link #checkUpdate(boolean)} / {@link #downloadUpdate()} 由 JS 桥线程或主线程调用，
 * 立即切状态后把耗时操作投递到单线程 worker；所有原生事件通过 {@link EventSink} 在主线程
 * 回调，由 MainActivity 转成 {@code window.TQNativeEvent(type, payload)}。
 *
 * <p>纯 Java 8 语法；零 AndroidX、零第三方依赖。
 */
public class OtaManager implements BundleWebViewClient.ContentProvider {

    private static final String TAG = "TQ.Ota";

    // ------------------------- 事件与错误码（docs/OTA.md 3.3） -------------------------
    public static final String EVENT_CHECKING = "ota_checking";
    public static final String EVENT_UP_TO_DATE = "ota_up_to_date";
    public static final String EVENT_AVAILABLE = "ota_available";
    public static final String EVENT_PROGRESS = "ota_progress";
    public static final String EVENT_DONE = "ota_done";
    public static final String EVENT_ERROR = "ota_error";

    public static final String ERR_NETWORK = "network";
    public static final String ERR_SHA256_MISMATCH = "sha256_mismatch";
    public static final String ERR_UNZIP_FAILED = "unzip_failed";
    public static final String ERR_TOO_LARGE = "too_large";
    public static final String ERR_NOT_AVAILABLE = "not_available";

    private static final long MAX_JSON_BYTES = 512L * 1024L;
    private static final long MAX_STATE_BYTES = 64L * 1024L;

    /** 原生事件出口，由 MainActivity 实现（负责切主线程 + evaluateJavascript）。 */
    public interface EventSink {
        void dispatchNativeEvent(String type, JSONObject payload);
    }

    private enum State {
        IDLE, CHECKING, UP_TO_DATE, AVAILABLE, DOWNLOADING, VERIFY, UNZIP, READY, ERROR
    }

    private final Object stateLock = new Object();
    private final Context appContext;
    private final EventSink eventSink;
    private final Handler mainHandler;
    private final ExecutorService worker;
    private final SharedPreferences prefs;
    private final int appVersionCode;
    private final String appVersionName;
    private final String deviceId;
    private final boolean debugBuild;

    /** 运行时状态（volatile：worker/主线程/桥线程都可能读）。 */
    private volatile State state = State.IDLE;
    private volatile int bundledVersion;
    /** 当前正在生效的已下载版本；0 表示使用内置 assets/web。 */
    private volatile int activeVersion;
    /** 当前生效的已下载内容目录；null 表示使用内置 assets/web。 */
    private volatile File activeDir;
    /** 已下载完成、等待重启生效的新版本；0 表示没有待生效版本。 */
    private volatile int pendingVersion;
    /** 已检查到、可下载的更新清单（内存态）。 */
    private volatile JSONObject availableUpdate;
    private volatile String lastErrorCode = "";
    private volatile String lastErrorMessage = "";
    /** 检查进行中又收到 JS 显式 checkUpdate 时排队，等当前检查结束后补一次完整事件。 */
    private volatile boolean explicitCheckQueued;
    /** 检查进行中又收到 downloadUpdate 时排队，等检查结束（拿到可用清单）后自动开始下载。 */
    private volatile boolean downloadQueued;

    /** 仅 worker 线程使用：下载过程中流式计算出的 sha256 / 字节数。 */
    private String lastDownloadSha256 = "";
    private long lastDownloadBytes;

    public OtaManager(Context context, EventSink eventSink) {
        this.appContext = context.getApplicationContext();
        this.eventSink = eventSink;
        this.bundledVersion = AppConfig.BUNDLED_CONTENT_VERSION;
        this.appVersionCode = readAppVersionCode();
        this.appVersionName = readAppVersionName();
        this.prefs = appContext.getSharedPreferences(AppConfig.PREFS_NAME, Context.MODE_PRIVATE);
        this.deviceId = loadOrCreateDeviceId();
        this.debugBuild = (appContext.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.worker = Executors.newSingleThreadExecutor();
    }

    // ==================================================================
    // 生命周期 / 启动解析（docs/OTA.md 3.1）
    // ==================================================================

    /**
     * 冷启动时解析生效内容目录并清理残留。主线程调用（只做很小的文件 IO）。
     */
    public void initialize() {
        try {
            cleanupDownloadDir();
            resolveEffectiveContent();
            cleanupVersionDirs();
            Log.i(TAG, "initialize done: bundled=" + bundledVersion + ", active="
                    + (activeDir != null ? "v" + activeVersion + " " + activeDir.getAbsolutePath() : "assets"));
        } catch (RuntimeException e) {
            Log.e(TAG, "initialize failed, fallback to bundled assets", e);
            activeDir = null;
            activeVersion = 0;
            pendingVersion = 0;
        }
    }

    /**
     * 解析 ota_state.json 指向的生效内容；坏目录删除，依次回退「上一版本目录 → 内置 assets」。
     */
    private void resolveEffectiveContent() {
        synchronized (stateLock) {
            activeDir = null;
            activeVersion = 0;
            pendingVersion = 0;

            JSONObject stateJson = readJsonFile(stateFile(), MAX_STATE_BYTES);
            if (stateJson == null) {
                Log.i(TAG, "no ota_state.json, use bundled assets");
                return;
            }
            int version = stateJson.optInt("contentVersion", 0);
            int previous = stateJson.optInt("previousVersion", 0);

            if (version > bundledVersion && isValidContentDir(version)) {
                adopt(version);
                writeState(version, previous);
                Log.i(TAG, "active content v" + version + " from ota_state.json");
                return;
            }

            // 当前指向的内容不可用/比内置旧：删除坏目录
            if (version > 0) {
                boolean deleted = deleteRecursively(versionDir(version));
                Log.w(TAG, "content v" + version + " invalid, removed=" + deleted);
            }

            // 回退上一版本（必须比内置新才有意义）
            if (previous > bundledVersion && previous != version && isValidContentDir(previous)) {
                adopt(previous);
                writeState(previous, 0);
                Log.w(TAG, "rollback to previous content v" + previous);
                return;
            }
            if (previous > 0 && previous != version) {
                deleteRecursively(versionDir(previous));
            }

            // 最后回退内置 assets
            deleteStateFile();
            Log.w(TAG, "no usable downloaded content, fallback to bundled assets");
        }
    }

    private void adopt(int version) {
        activeVersion = version;
        activeDir = versionDir(version);
    }

    /**
     * WebView 主文档加载失败时调用（主线程）：删除坏目录并按「上一版本 → 待生效版本 → 内置」回退。
     *
     * @return true 表示已执行回退（调用方需要重新 loadUrl）；false 表示当前已是内置资源，无法再回退。
     */
    public boolean handleContentLoadFailure() {
        synchronized (stateLock) {
            if (activeDir == null) {
                Log.e(TAG, "bundled assets failed to load, no further fallback");
                return false;
            }
            int badVersion = activeVersion;
            File badDir = activeDir;
            JSONObject stateJson = readJsonFile(stateFile(), MAX_STATE_BYTES);
            int previous = stateJson != null ? stateJson.optInt("previousVersion", 0) : 0;

            deleteRecursively(badDir);
            deleteStateFile();
            activeDir = null;
            activeVersion = 0;

            int fallbackVersion = 0;
            if (previous > bundledVersion && previous != badVersion && isValidContentDir(previous)) {
                fallbackVersion = previous;
            } else if (pendingVersion > 0 && pendingVersion != badVersion && isValidContentDir(pendingVersion)) {
                fallbackVersion = pendingVersion;
            }

            if (fallbackVersion > 0) {
                adopt(fallbackVersion);
                pendingVersion = 0;
                writeState(fallbackVersion, 0);
            }
            state = State.IDLE;
            lastErrorCode = "load_failed";
            lastErrorMessage = "内容 v" + badVersion + " 加载失败，已回退到"
                    + (fallbackVersion > 0 ? "v" + fallbackVersion : "内置资源");
            Log.w(TAG, lastErrorMessage);
            return true;
        }
    }

    /** 重启 WebView 前调用：把已下载完成的内容切换为生效版本（getState 在重启前仍返回旧版本）。 */
    public void activatePendingContent() {
        int version;
        synchronized (stateLock) {
            version = pendingVersion;
            if (version <= 0) {
                return;
            }
            if (!isValidContentDir(version)) {
                Log.w(TAG, "pending content v" + version + " invalid, discarded");
                deleteRecursively(versionDir(version));
                pendingVersion = 0;
                return;
            }
            activeVersion = version;
            activeDir = versionDir(version);
            pendingVersion = 0;
            Log.i(TAG, "pending content v" + version + " activated");
        }
        cleanupVersionDirs();
    }

    // ==================================================================
    // 检查更新（CHECKING → UP_TO_DATE | AVAILABLE）
    // ==================================================================

    /**
     * 检查更新。
     *
     * @param silent true = 冷启动静默检查：只上报“有更新”，不打断用户、不报错。
     */
    public void checkUpdate(final boolean silent) {
        synchronized (stateLock) {
            if (isBusy()) {
                if (!silent && state == State.CHECKING) {
                    explicitCheckQueued = true;
                    Log.w(TAG, "checkUpdate queued: another check is running");
                } else {
                    Log.w(TAG, "checkUpdate ignored, state=" + state);
                }
                return;
            }
            state = State.CHECKING;
        }
        if (!silent) {
            dispatch(EVENT_CHECKING, json("contentVersion", getContentVersion()));
        }
        try {
            worker.execute(new Runnable() {
                @Override
                public void run() {
                    doCheckUpdate(silent);
                    runQueuedOperations();
                }
            });
        } catch (RuntimeException e) {
            Log.w(TAG, "worker rejected checkUpdate (shutting down?)", e);
            setError(ERR_NETWORK, "更新检查已取消");
        }
    }

    /** 处理检查进行中排队的「显式检查 / 下载」请求，保证 JS 不会一直停在 loading 态。 */
    private void runQueuedOperations() {
        boolean rerunCheck;
        boolean runDownload;
        synchronized (stateLock) {
            rerunCheck = explicitCheckQueued;
            explicitCheckQueued = false;
            runDownload = downloadQueued && availableUpdate != null;
            downloadQueued = false;
        }
        if (runDownload) {
            Log.i(TAG, "run queued download after check finished");
            downloadUpdate();
        }
        if (rerunCheck) {
            Log.i(TAG, "run queued explicit check after check finished");
            checkUpdate(false);
        }
    }

    private void doCheckUpdate(boolean silent) {
        try {
            int current = Math.max(getContentVersion(), pendingVersion);
            JSONObject content = fetchVersionManifest(current);
            if (content == null) {
                finishCheckUpToDate(silent);
                return;
            }
            int version = content.optInt("version", 0);
            int minShellVersion = content.optInt("minShellVersion", 0);
            if (version <= current) {
                finishCheckUpToDate(silent);
                return;
            }
            if (minShellVersion > appVersionCode) {
                String message = "新内容需要更高版本 APP（minShellVersion=" + minShellVersion
                        + "，当前 shellVersionCode=" + appVersionCode + "），请先升级 APP";
                if (silent) {
                    setError(ERR_NOT_AVAILABLE, message);
                } else {
                    fail(ERR_NOT_AVAILABLE, message);
                }
                return;
            }

            JSONObject meta = buildUpdateMeta(content);
            if (meta == null) {
                String message = "服务器版本清单不完整（缺少 sha256/size/zipUrl 或地址非 HTTPS）";
                if (silent) {
                    setError(ERR_NOT_AVAILABLE, message);
                } else {
                    fail(ERR_NOT_AVAILABLE, message);
                }
                return;
            }

            availableUpdate = meta;
            synchronized (stateLock) {
                state = State.AVAILABLE;
                lastErrorCode = "";
                lastErrorMessage = "";
            }
            dispatch(EVENT_AVAILABLE, json(
                    "version", meta.optInt("version", 0),
                    "notes", meta.optString("notes", ""),
                    "size", meta.optLong("size", 0),
                    "publishedAt", meta.optString("publishedAt", "")));
        } catch (OtaException e) {
            if (silent) {
                setError(e.code, e.getMessage());
                Log.w(TAG, "silent update check failed: " + e.code + " " + e.getMessage());
            } else {
                fail(e.code, e.getMessage());
            }
        } catch (RuntimeException e) {
            Log.e(TAG, "check update crashed", e);
            if (silent) {
                setError(ERR_NETWORK, "检查更新失败");
            } else {
                fail(ERR_NETWORK, "检查更新失败，请稍后重试");
            }
        }
    }

    private void finishCheckUpToDate(boolean silent) {
        availableUpdate = null;
        synchronized (stateLock) {
            state = State.UP_TO_DATE;
            lastErrorCode = "";
            lastErrorMessage = "";
        }
        if (!silent) {
            dispatch(EVENT_UP_TO_DATE, json("contentVersion", getContentVersion()));
        }
    }

    /**
     * GET {apiBase}/api/version?platform=android&amp;shell=&lt;code&gt;&amp;content=&lt;ver&gt;&amp;channel=test
     *
     * @return content 对象；服务器没有内容包时返回 null。
     */
    private JSONObject fetchVersionManifest(int currentContentVersion) throws OtaException {
        String url = AppConfig.API_BASE + AppConfig.API_VERSION_PATH
                + "?platform=" + urlEncode(AppConfig.PLATFORM)
                + "&shell=" + appVersionCode
                + "&content=" + currentContentVersion
                + "&channel=" + urlEncode(AppConfig.CHANNEL);
        String body = httpGetTextWithRetry(url, "application/json");
        try {
            JSONObject root = new JSONObject(body);
            if (!root.optBoolean("ok", false)) {
                throw new OtaException(ERR_NETWORK, "版本接口返回错误");
            }
            return root.optJSONObject("content");
        } catch (JSONException e) {
            throw new OtaException(ERR_NETWORK, "版本接口返回格式错误");
        }
    }

    private JSONObject buildUpdateMeta(JSONObject content) {
        try {
            int version = content.optInt("version", 0);
            long size = content.optLong("size", 0);
            String sha256 = content.optString("sha256", "").trim().toLowerCase(Locale.US);
            String zipUrl = content.optString("zipUrl", "").trim();
            if (zipUrl.isEmpty()) {
                String zipPath = content.optString("zipPath", "").trim();
                if (!zipPath.isEmpty()) {
                    zipUrl = zipPath.startsWith("http") ? zipPath : AppConfig.API_BASE + zipPath;
                }
            }
            if (version <= 0 || size <= 0 || sha256.length() != 64 || zipUrl.isEmpty()) {
                return null;
            }
            if (!isTrustedZipUrl(zipUrl)) {
                return null;
            }
            if (size > AppConfig.MAX_BUNDLE_BYTES) {
                return null;
            }
            JSONObject meta = new JSONObject();
            meta.put("version", version);
            meta.put("minShellVersion", content.optInt("minShellVersion", 0));
            meta.put("notes", content.optString("notes", ""));
            meta.put("size", size);
            meta.put("sha256", sha256);
            meta.put("publishedAt", content.optString("publishedAt", ""));
            meta.put("zipUrl", zipUrl);
            return meta;
        } catch (JSONException e) {
            return null;
        }
    }

    // ==================================================================
    // 下载 / 校验 / 解压 / 安装（DOWNLOADING → VERIFY → UNZIP → READY）
    // ==================================================================

    /** 下载并安装当前可用的更新（进度通过事件回调）。 */
    public void downloadUpdate() {
        final JSONObject meta;
        synchronized (stateLock) {
            if (isBusy()) {
                if (state == State.CHECKING && availableUpdate != null) {
                    downloadQueued = true;
                    Log.w(TAG, "downloadUpdate queued: check is running");
                } else {
                    Log.w(TAG, "downloadUpdate ignored, state=" + state);
                }
                return;
            }
            meta = availableUpdate;
            if (meta != null) {
                state = State.DOWNLOADING;
            }
        }
        if (meta == null) {
            fail(ERR_NOT_AVAILABLE, "当前没有可用更新，请先检查更新");
            return;
        }
        if (meta.optLong("size", 0) > AppConfig.MAX_BUNDLE_BYTES) {
            fail(ERR_TOO_LARGE, "内容包超过 20MB 上限");
            return;
        }
        try {
            worker.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        doDownloadUpdate(meta);
                    } catch (RuntimeException e) {
                        Log.e(TAG, "download task crashed", e);
                        synchronized (stateLock) {
                            if (state != State.ERROR) {
                                fail(ERR_UNZIP_FAILED, "更新失败，请重试");
                            }
                        }
                    }
                }
            });
        } catch (RuntimeException e) {
            Log.w(TAG, "worker rejected downloadUpdate (shutting down?)", e);
            setError(ERR_NETWORK, "更新下载已取消");
        }
    }

    private void doDownloadUpdate(JSONObject meta) {
        final int version = meta.optInt("version", 0);
        final long expectedSize = meta.optLong("size", 0);
        final String expectedSha256 = meta.optString("sha256", "").toLowerCase(Locale.US);
        final String zipUrl = meta.optString("zipUrl", "");
        if (version <= 0 || !isTrustedZipUrl(zipUrl)) {
            fail(ERR_NETWORK, "更新清单无效，请重新检查更新");
            return;
        }

        File downloadDir = new File(otaDir(), AppConfig.DIR_DOWNLOAD);
        if (!downloadDir.isDirectory() && !downloadDir.mkdirs()) {
            fail(ERR_UNZIP_FAILED, "无法创建下载目录");
            return;
        }
        File zipFile = new File(downloadDir, AppConfig.FILE_DOWNLOAD_TMP);
        deleteFileQuietly(zipFile);

        // ---- 下载（网络错误重试 2 次：退避 1s / 2s）----
        boolean downloaded = false;
        for (int attempt = 0; attempt <= AppConfig.HTTP_RETRIES && !downloaded; attempt++) {
            if (attempt > 0) {
                sleepQuietly(retryDelayMs(attempt));
                Log.w(TAG, "retry download, attempt " + attempt);
            }
            deleteFileQuietly(zipFile);
            try {
                downloadToFile(zipUrl, zipFile, expectedSize);
                downloaded = true;
            } catch (OtaException e) {
                deleteFileQuietly(zipFile);
                fail(e.code, e.getMessage() != null ? e.getMessage() : "下载失败");
                return;
            } catch (IOException e) {
                deleteFileQuietly(zipFile);
                Log.w(TAG, "download attempt " + attempt + " failed", e);
                if (attempt >= AppConfig.HTTP_RETRIES) {
                    fail(ERR_NETWORK, "下载失败，请检查网络后重试");
                    return;
                }
            }
        }
        if (!downloaded) {
            fail(ERR_NETWORK, "下载失败，请检查网络后重试");
            return;
        }

        // ---- 校验 sha256（下载时已流式计算）----
        synchronized (stateLock) {
            state = State.VERIFY;
        }
        emitProgress("verify", 100, lastDownloadBytes, expectedSize);
        if (lastDownloadBytes > AppConfig.MAX_BUNDLE_BYTES) {
            deleteFileQuietly(zipFile);
            fail(ERR_TOO_LARGE, "内容包超过 20MB 上限");
            return;
        }
        if (!expectedSha256.equalsIgnoreCase(lastDownloadSha256)) {
            deleteFileQuietly(zipFile);
            fail(ERR_SHA256_MISMATCH, "内容包 sha256 校验失败，已删除，请重试");
            return;
        }
        if (expectedSize > 0 && lastDownloadBytes != expectedSize) {
            deleteFileQuietly(zipFile);
            fail(ERR_SHA256_MISMATCH, "内容包大小与清单不一致，已删除，请重试");
            return;
        }

        // ---- 解压到 web/.tmp-<version>/ ----
        synchronized (stateLock) {
            state = State.UNZIP;
        }
        emitProgress("unzip", 0, 0, 0);
        File tmpDir = new File(webRoot(), AppConfig.TMP_CONTENT_PREFIX + version);
        deleteRecursively(tmpDir);
        try {
            unzipBundle(zipFile, tmpDir, version);
        } catch (OtaException e) {
            deleteRecursively(tmpDir);
            deleteFileQuietly(zipFile);
            fail(e.code, e.getMessage() != null ? e.getMessage() : "内容包解压失败");
            return;
        } catch (IOException e) {
            Log.w(TAG, "unzip failed", e);
            deleteRecursively(tmpDir);
            deleteFileQuietly(zipFile);
            fail(ERR_UNZIP_FAILED, "内容包解压失败");
            return;
        }
        emitProgress("unzip", 100, 0, 0);

        // ---- 原子切换：web/.tmp-<version> → web/<version> ----
        File targetDir = versionDir(version);
        if (targetDir.exists() && !deleteRecursively(targetDir)) {
            deleteRecursively(tmpDir);
            deleteFileQuietly(zipFile);
            fail(ERR_UNZIP_FAILED, "无法清理旧内容目录");
            return;
        }
        if (!tmpDir.renameTo(targetDir)) {
            Log.w(TAG, "rename " + tmpDir + " -> " + targetDir + " failed");
            deleteRecursively(tmpDir);
            deleteFileQuietly(zipFile);
            fail(ERR_UNZIP_FAILED, "内容目录切换失败，请重试");
            return;
        }

        // ---- 写 ota_state.json，标记待重启生效 ----
        int previousVersion;
        synchronized (stateLock) {
            previousVersion = activeDir != null ? activeVersion : 0;
            pendingVersion = version;
            writeState(version, previousVersion);
            state = State.READY;
            lastErrorCode = "";
            lastErrorMessage = "";
            availableUpdate = null;
        }
        deleteFileQuietly(zipFile);
        cleanupVersionDirs();
        Log.i(TAG, "content v" + version + " downloaded & unzipped, previous=" + previousVersion
                + ", restart required");
        dispatch(EVENT_DONE, json("contentVersion", version, "restartRequired", true));
    }

    /**
     * 下载到目标文件并「同时」流式计算 sha256（契约 3.2）。
     */
    private void downloadToFile(String urlStr, File dest, long expectedSize) throws IOException, OtaException {
        URL url = new URL(urlStr);
        if (!"https".equalsIgnoreCase(url.getProtocol())) {
            throw new OtaException(ERR_NETWORK, "下载地址必须为 HTTPS");
        }
        HttpURLConnection conn = null;
        InputStream in = null;
        OutputStream out = null;
        MessageDigest digest = newSha256();
        long received = 0;
        try {
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(AppConfig.HTTP_TIMEOUT_MS);
            conn.setReadTimeout(AppConfig.HTTP_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setUseCaches(false);
            conn.setRequestProperty("Accept", "application/zip, application/octet-stream, */*");
            conn.setRequestProperty("User-Agent", userAgent());
            conn.setRequestProperty("Connection", "close");

            int statusCode = conn.getResponseCode();
            if (statusCode != HttpURLConnection.HTTP_OK) {
                if (statusCode >= 500) {
                    throw new IOException("download HTTP " + statusCode);
                }
                throw new OtaException(ERR_NETWORK, "下载失败：HTTP " + statusCode);
            }
            URL finalUrl = conn.getURL();
            if (finalUrl == null || !"https".equalsIgnoreCase(finalUrl.getProtocol())) {
                throw new OtaException(ERR_NETWORK, "下载被重定向到非 HTTPS 地址，已拒绝");
            }

            long total = conn.getContentLengthLong();
            if (total <= 0) {
                total = expectedSize;
            }
            if (total > AppConfig.MAX_BUNDLE_BYTES) {
                throw new OtaException(ERR_TOO_LARGE, "内容包超过 20MB 上限");
            }

            in = conn.getInputStream();
            out = new FileOutputStream(dest);
            byte[] buffer = new byte[64 * 1024];
            long lastEmitAt = 0L;
            int lastPercent = -1;
            int read;
            while ((read = in.read(buffer)) != -1) {
                received += read;
                if (received > AppConfig.MAX_BUNDLE_BYTES) {
                    throw new OtaException(ERR_TOO_LARGE, "内容包超过 20MB 上限");
                }
                out.write(buffer, 0, read);
                digest.update(buffer, 0, read);
                int percent = total > 0 ? (int) Math.min(100L, received * 100L / total) : 0;
                long now = System.currentTimeMillis();
                if (percent != lastPercent && (percent >= 100 || now - lastEmitAt >= 150L)) {
                    lastPercent = percent;
                    lastEmitAt = now;
                    emitProgress("download", percent, received, total);
                }
            }
            out.flush();
            lastDownloadBytes = received;
            lastDownloadSha256 = toHex(digest.digest());
        } finally {
            closeQuietly(out);
            closeQuietly(in);
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /**
     * 解压内容包到临时目录：zip-slip 防护、总量 20MB 上限、必需文件与版本一致性校验。
     */
    private void unzipBundle(File zipFile, File destDir, int expectedVersion) throws IOException, OtaException {
        if (!destDir.isDirectory() && !destDir.mkdirs() && !destDir.isDirectory()) {
            throw new OtaException(ERR_UNZIP_FAILED, "无法创建临时内容目录");
        }
        String destRoot = destDir.getCanonicalPath();
        long totalWritten = 0L;
        ZipInputStream zipInput = null;
        try {
            zipInput = new ZipInputStream(new BufferedInputStream(new FileInputStream(zipFile)));
            ZipEntry entry;
            byte[] buffer = new byte[32 * 1024];
            while ((entry = zipInput.getNextEntry()) != null) {
                String entryName = entry.getName();
                if (entryName == null || entryName.isEmpty()) {
                    continue;
                }
                String relativePath = normalizeZipPath(entryName);
                if (relativePath == null) {
                    continue;
                }
                File target = new File(destDir, relativePath);
                String canonical = target.getCanonicalPath();
                // zip-slip 最终防线：解压目标必须落在临时目录内。
                if (!canonical.equals(destRoot) && !canonical.startsWith(destRoot + File.separator)) {
                    throw new OtaException(ERR_UNZIP_FAILED, "内容包含非法路径（zip-slip）：" + entryName);
                }
                if (entry.isDirectory()) {
                    ensureDir(target);
                    continue;
                }
                ensureDir(target.getParentFile());
                FileOutputStream out = null;
                try {
                    out = new FileOutputStream(target);
                    int read;
                    while ((read = zipInput.read(buffer)) != -1) {
                        totalWritten += read;
                        if (totalWritten > AppConfig.MAX_BUNDLE_BYTES) {
                            throw new OtaException(ERR_TOO_LARGE, "内容包解压后超过 20MB 上限");
                        }
                        out.write(buffer, 0, read);
                    }
                    out.flush();
                } finally {
                    closeQuietly(out);
                }
            }
        } finally {
            closeQuietly(zipInput);
        }

        File indexFile = new File(destDir, AppConfig.INDEX_FILE);
        File bundleFile = new File(destDir, AppConfig.BUNDLE_MANIFEST);
        if (!indexFile.isFile()) {
            throw new OtaException(ERR_UNZIP_FAILED, "内容包缺少 index.html");
        }
        if (!bundleFile.isFile()) {
            throw new OtaException(ERR_UNZIP_FAILED, "内容包缺少 bundle.json");
        }
        JSONObject bundle = readJsonFile(bundleFile, MAX_JSON_BYTES);
        if (bundle == null) {
            throw new OtaException(ERR_UNZIP_FAILED, "内容包 bundle.json 解析失败");
        }
        int bundleVersion = bundle.optInt("contentVersion", -1);
        if (bundleVersion != expectedVersion) {
            throw new OtaException(ERR_UNZIP_FAILED,
                    "内容包版本不一致：bundle.json=" + bundleVersion + "，清单=" + expectedVersion);
        }
    }

    /**
     * zip entry 名规范化：拒绝反斜杠、绝对路径、盘符、{@code ..} 段；目录项返回 null。
     */
    private static String normalizeZipPath(String entryName) throws OtaException {
        if (entryName.indexOf('\\') >= 0) {
            throw new OtaException(ERR_UNZIP_FAILED, "内容包含非法路径（反斜杠）：" + entryName);
        }
        if (entryName.indexOf('\u0000') >= 0 || entryName.indexOf(':') >= 0) {
            throw new OtaException(ERR_UNZIP_FAILED, "内容包含非法路径：" + entryName);
        }
        if (entryName.startsWith("/")) {
            throw new OtaException(ERR_UNZIP_FAILED, "内容包含绝对路径：" + entryName);
        }
        String[] segments = entryName.split("/", -1);
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < segments.length; i++) {
            String segment = segments[i];
            if (segment.isEmpty() || ".".equals(segment)) {
                continue;
            }
            if ("..".equals(segment)) {
                throw new OtaException(ERR_UNZIP_FAILED, "内容包含非法路径（..）：" + entryName);
            }
            if (builder.length() > 0) {
                builder.append('/');
            }
            builder.append(segment);
        }
        if (builder.length() == 0) {
            return null;
        }
        String relativePath = builder.toString();
        if (relativePath.length() > 512) {
            throw new OtaException(ERR_UNZIP_FAILED, "内容包内路径过长：" + entryName);
        }
        return relativePath;
    }

    // ==================================================================
    // ota_state.json / 目录管理
    // ==================================================================

    /**
     * 写 ota_state.json：{"contentVersion":2,"activeDir":"files/web/2","previousVersion":1}
     */
    private void writeState(int contentVersion, int previousVersion) {
        try {
            JSONObject json = new JSONObject();
            json.put("contentVersion", contentVersion);
            json.put("activeDir", AppConfig.ACTIVE_DIR_PREFIX + contentVersion);
            json.put("previousVersion", previousVersion);
            writeTextAtomic(stateFile(), json.toString());
        } catch (JSONException e) {
            Log.w(TAG, "write ota_state.json failed", e);
        }
    }

    private void deleteStateFile() {
        File file = stateFile();
        if (file.exists() && !file.delete()) {
            Log.w(TAG, "delete ota_state.json failed");
        }
    }

    /** 清理旧的下载临时目录（启动时）。 */
    private void cleanupDownloadDir() {
        deleteRecursively(new File(otaDir(), AppConfig.DIR_DOWNLOAD));
    }

    /** 删除 .tmp-* 残留；删除比内置旧/无效的版本目录；最多保留 KEEP_VERSION_DIRS 个版本。 */
    private void cleanupVersionDirs() {
        File root = webRoot();
        File[] children = root.listFiles();
        if (children == null) {
            return;
        }
        List<Integer> versions = new ArrayList<Integer>();
        for (int i = 0; i < children.length; i++) {
            File child = children[i];
            if (child == null) {
                continue;
            }
            String name = child.getName();
            if (name.startsWith(AppConfig.TMP_CONTENT_PREFIX)) {
                deleteRecursively(child);
                continue;
            }
            if (!child.isDirectory() || !isDigits(name)) {
                continue;
            }
            int version = parseInt(name, -1);
            if (version <= 0) {
                continue;
            }
            if (version != activeVersion && version != pendingVersion && version <= bundledVersion) {
                deleteRecursively(child);
                continue;
            }
            versions.add(Integer.valueOf(version));
        }
        Collections.sort(versions);
        while (versions.size() > AppConfig.KEEP_VERSION_DIRS) {
            boolean removed = false;
            for (int i = 0; i < versions.size(); i++) {
                int version = versions.get(i).intValue();
                if (version == activeVersion || version == pendingVersion) {
                    continue;
                }
                deleteRecursively(versionDir(version));
                versions.remove(i);
                removed = true;
                break;
            }
            if (!removed) {
                break;
            }
        }
    }

    private boolean isValidContentDir(int version) {
        File dir = versionDir(version);
        if (!dir.isDirectory()) {
            return false;
        }
        if (!new File(dir, AppConfig.INDEX_FILE).isFile()) {
            return false;
        }
        File bundleFile = new File(dir, AppConfig.BUNDLE_MANIFEST);
        if (!bundleFile.isFile()) {
            return false;
        }
        JSONObject bundle = readJsonFile(bundleFile, MAX_JSON_BYTES);
        return bundle != null && bundle.optInt("contentVersion", -1) == version;
    }

    // ==================================================================
    // Java → JS 事件 / 状态
    // ==================================================================

    /**
     * 事件统一出口：切主线程后交给 MainActivity（其内部执行
     * {@code window.TQNativeEvent(type, payload)}）。
     */
    private void dispatch(final String type, final JSONObject payload) {
        final EventSink sink = eventSink;
        if (sink == null) {
            return;
        }
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    sink.dispatchNativeEvent(type, payload);
                } catch (RuntimeException e) {
                    Log.w(TAG, "dispatch native event failed: " + type, e);
                }
            }
        });
    }

    private void emitProgress(final String phase, final int percent, final long received, final long total) {
        dispatch(EVENT_PROGRESS, json(
                "phase", phase,
                "percent", Integer.valueOf(percent),
                "received", Long.valueOf(received),
                "total", Long.valueOf(total)));
    }

    private void fail(String code, String message) {
        setError(code, message);
        Log.w(TAG, "OTA error [" + code + "] " + message);
        dispatch(EVENT_ERROR, json("code", code, "message", message));
    }

    private void setError(String code, String message) {
        synchronized (stateLock) {
            state = State.ERROR;
            lastErrorCode = code;
            lastErrorMessage = message;
        }
    }

    /** getState()：字段与 docs/OTA.md 3.3 完全一致。 */
    public String getStateJson() {
        JSONObject json = new JSONObject();
        try {
            json.put("platform", AppConfig.PLATFORM);
            json.put("appVersionCode", appVersionCode);
            json.put("appVersionName", appVersionName);
            json.put("bundledContentVersion", bundledVersion);
            json.put("contentVersion", getContentVersion());
            json.put("contentDir", activeDir != null
                    ? AppConfig.ACTIVE_DIR_PREFIX + activeVersion : "assets");
            json.put("channel", AppConfig.CHANNEL);
            json.put("apiBase", AppConfig.API_BASE);
            json.put("deviceId", deviceId);
            json.put("isDebug", debugBuild);
        } catch (JSONException e) {
            Log.w(TAG, "getStateJson failed", e);
        }
        return json.toString();
    }

    /** getLogInfo()：调试用一行/多行文本。 */
    public String getLogInfo() {
        StringBuilder builder = new StringBuilder();
        builder.append("app=").append(appVersionName).append('(').append(appVersionCode).append(")\n");
        builder.append("bundledContentVersion=").append(bundledVersion).append('\n');
        builder.append("contentVersion=").append(getContentVersion()).append('\n');
        builder.append("contentDir=").append(activeDir != null ? activeDir.getAbsolutePath() : "assets/web").append('\n');
        builder.append("pendingVersion=").append(pendingVersion).append('\n');
        builder.append("state=").append(state.name()).append('\n');
        builder.append("apiBase=").append(AppConfig.API_BASE).append('\n');
        builder.append("channel=").append(AppConfig.CHANNEL).append('\n');
        builder.append("deviceId=").append(deviceId).append('\n');
        JSONObject update = availableUpdate;
        builder.append("availableVersion=").append(update != null ? update.optInt("version", 0) : 0).append('\n');
        builder.append("lastError=").append(lastErrorCode).append(' ').append(lastErrorMessage).append('\n');
        builder.append("isDebug=").append(debugBuild);
        return builder.toString();
    }

    // ==================================================================
    // BundleWebViewClient.ContentProvider
    // ==================================================================

    @Override
    public File getActiveContentDir() {
        return activeDir;
    }

    @Override
    public int getContentVersion() {
        return activeDir != null ? activeVersion : bundledVersion;
    }

    /** 释放资源（Activity onDestroy 调用）。 */
    public void shutdown() {
        worker.shutdownNow();
        mainHandler.removeCallbacksAndMessages(null);
        Log.i(TAG, "shutdown");
    }

    // ==================================================================
    // HTTP
    // ==================================================================

    private String httpGetTextWithRetry(String url, String accept) throws OtaException {
        IOException lastError = null;
        for (int attempt = 0; attempt <= AppConfig.HTTP_RETRIES; attempt++) {
            if (attempt > 0) {
                sleepQuietly(retryDelayMs(attempt));
                Log.w(TAG, "retry GET, attempt " + attempt);
            }
            try {
                return httpGetText(url, accept);
            } catch (IOException e) {
                lastError = e;
            }
        }
        Log.w(TAG, "GET failed after " + AppConfig.HTTP_RETRIES + " retries", lastError);
        throw new OtaException(ERR_NETWORK, "网络请求失败，请检查网络后重试");
    }

    private String httpGetText(String urlStr, String accept) throws IOException, OtaException {
        URL url = new URL(urlStr);
        if (!"https".equalsIgnoreCase(url.getProtocol())) {
            throw new OtaException(ERR_NETWORK, "非 HTTPS 请求被拒绝");
        }
        HttpURLConnection conn = null;
        InputStream in = null;
        try {
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(AppConfig.HTTP_TIMEOUT_MS);
            conn.setReadTimeout(AppConfig.HTTP_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setUseCaches(false);
            conn.setRequestProperty("Accept", accept);
            conn.setRequestProperty("User-Agent", userAgent());
            conn.setRequestProperty("Connection", "close");

            int statusCode = conn.getResponseCode();
            if (statusCode != HttpURLConnection.HTTP_OK) {
                throw new OtaException(ERR_NETWORK, "版本接口返回 HTTP " + statusCode);
            }
            URL finalUrl = conn.getURL();
            if (finalUrl == null || !"https".equalsIgnoreCase(finalUrl.getProtocol())) {
                throw new OtaException(ERR_NETWORK, "请求被重定向到非 HTTPS 地址，已拒绝");
            }
            in = conn.getInputStream();
            byte[] data = readFullyLimited(in, 1024L * 1024L);
            if (data == null) {
                throw new OtaException(ERR_NETWORK, "版本接口响应过大");
            }
            return new String(data, StandardCharsets.UTF_8);
        } finally {
            closeQuietly(in);
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    // ==================================================================
    // 工具方法
    // ==================================================================

    private static long retryDelayMs(int attempt) {
        // attempt 从 1 开始：1s、2s（指数退避，契约 3.2）
        return AppConfig.RETRY_BACKOFF_BASE_MS * (1L << (attempt - 1));
    }

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private int readAppVersionCode() {
        try {
            PackageInfo info = appContext.getPackageManager()
                    .getPackageInfo(appContext.getPackageName(), 0);
            if (info.versionCode > 0) {
                return info.versionCode;
            }
        } catch (Exception e) {
            Log.w(TAG, "read versionCode failed, use AppConfig default", e);
        }
        return AppConfig.APP_VERSION_CODE;
    }

    private String readAppVersionName() {
        try {
            PackageInfo info = appContext.getPackageManager()
                    .getPackageInfo(appContext.getPackageName(), 0);
            if (info.versionName != null && info.versionName.length() > 0) {
                return info.versionName;
            }
        } catch (Exception e) {
            Log.w(TAG, "read versionName failed, use AppConfig default", e);
        }
        return AppConfig.APP_VERSION_NAME;
    }

    private String loadOrCreateDeviceId() {
        String existing = prefs.getString(AppConfig.PREF_DEVICE_ID, null);
        if (existing != null && existing.length() >= 8) {
            return existing;
        }
        String generated = UUID.randomUUID().toString();
        prefs.edit().putString(AppConfig.PREF_DEVICE_ID, generated).apply();
        return generated;
    }

    private String userAgent() {
        return "TreasureQuestShell/" + appVersionName + " (Android; content=" + getContentVersion() + ")";
    }

    private static boolean isTrustedZipUrl(String urlStr) {
        try {
            URL url = new URL(urlStr);
            if (!"https".equalsIgnoreCase(url.getProtocol())) {
                return false;
            }
            String host = url.getHost();
            if (host == null || host.length() == 0) {
                return false;
            }
            String apiHost = new URL(AppConfig.API_BASE).getHost();
            return host.equalsIgnoreCase(apiHost) || host.toLowerCase(Locale.US).endsWith(".zzysjqr.cn");
        } catch (Exception e) {
            return false;
        }
    }

    private static String urlEncode(String value) {
        try {
            return URLEncoder.encode(value, StandardCharsets.UTF_8.name());
        } catch (UnsupportedEncodingException e) {
            return value;
        }
    }

    private File webRoot() {
        File dir = new File(appContext.getFilesDir(), AppConfig.DIR_WEB);
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            Log.w(TAG, "cannot create web root: " + dir);
        }
        return dir;
    }

    private File otaDir() {
        File dir = new File(appContext.getFilesDir(), AppConfig.DIR_OTA);
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            Log.w(TAG, "cannot create ota dir: " + dir);
        }
        return dir;
    }

    private File versionDir(int version) {
        return new File(webRoot(), String.valueOf(version));
    }

    private File stateFile() {
        return new File(otaDir(), AppConfig.FILE_OTA_STATE);
    }

    private boolean isBusy() {
        State current = state;
        return current == State.CHECKING
                || current == State.DOWNLOADING
                || current == State.VERIFY
                || current == State.UNZIP;
    }

    private static JSONObject json(Object... keyValues) {
        JSONObject json = new JSONObject();
        for (int i = 0; i + 1 < keyValues.length; i += 2) {
            try {
                json.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
            } catch (JSONException ignored) {
                // key 非 null，理论上不会发生
            }
        }
        return json;
    }

    private static JSONObject readJsonFile(File file, long maxBytes) {
        String text = readTextFile(file, maxBytes);
        if (text == null) {
            return null;
        }
        try {
            return new JSONObject(text);
        } catch (JSONException e) {
            return null;
        }
    }

    private static String readTextFile(File file, long maxBytes) {
        InputStream in = null;
        try {
            if (file == null || !file.isFile() || file.length() > maxBytes) {
                return null;
            }
            in = new FileInputStream(file);
            byte[] data = readFullyLimited(in, maxBytes);
            return data != null ? new String(data, StandardCharsets.UTF_8) : null;
        } catch (IOException e) {
            return null;
        } finally {
            closeQuietly(in);
        }
    }

    private static byte[] readFullyLimited(InputStream in, long maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8 * 1024];
        long total = 0;
        int read;
        while ((read = in.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) {
                return null;
            }
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }

    private static boolean writeTextAtomic(File target, String text) {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            Log.w(TAG, "writeTextAtomic mkdirs failed: " + parent);
            return false;
        }
        File tmp = new File(parent, target.getName() + ".tmp");
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(tmp);
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
            closeQuietly(out);
            out = null;
            if (tmp.renameTo(target)) {
                return true;
            }
            // 部分文件系统上 rename 覆盖已存在文件会失败：先删旧文件再重试。
            if (target.exists() && target.delete() && tmp.renameTo(target)) {
                return true;
            }
            Log.w(TAG, "writeTextAtomic rename failed: " + target);
            return false;
        } catch (IOException e) {
            Log.w(TAG, "writeTextAtomic failed: " + target, e);
            return false;
        } finally {
            closeQuietly(out);
            if (tmp.exists()) {
                tmp.delete();
            }
        }
    }

    private static void ensureDir(File dir) throws IOException {
        if (dir == null || dir.isDirectory()) {
            return;
        }
        if (!dir.mkdirs() && !dir.isDirectory()) {
            throw new IOException("cannot create dir: " + dir);
        }
    }

    private static boolean deleteRecursively(File file) {
        if (file == null || !file.exists()) {
            return true;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (int i = 0; i < children.length; i++) {
                    deleteRecursively(children[i]);
                }
            }
        }
        try {
            return file.delete();
        } catch (SecurityException e) {
            return false;
        }
    }

    private static void deleteFileQuietly(File file) {
        if (file != null && file.exists() && !file.delete()) {
            Log.w(TAG, "delete file failed: " + file);
        }
    }

    private static boolean isDigits(String text) {
        if (text == null || text.isEmpty()) {
            return false;
        }
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < '0' || c > '9') {
                return false;
            }
        }
        return true;
    }

    private static int parseInt(String text, int defaultValue) {
        try {
            return Integer.parseInt(text);
        } catch (NumberFormatException e) {
            return defaultValue;
        }
    }

    private static MessageDigest newSha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }

    private static String toHex(byte[] bytes) {
        final char[] digits = "0123456789abcdef".toCharArray();
        char[] chars = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 0xFF;
            chars[i * 2] = digits[value >>> 4];
            chars[i * 2 + 1] = digits[value & 0x0F];
        }
        return new String(chars);
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

    /** 内部受检异常：code 对齐 docs/OTA.md 的 ota_error.code。 */
    private static class OtaException extends Exception {
        private static final long serialVersionUID = 1L;
        final String code;

        OtaException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
