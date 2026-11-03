package cn.zzysjqr.treasurequest;

/**
 * 全局常量与构建期注入点（Android 壳）。
 *
 * <p>硬性约定：本文件必须位于
 * {@code android/app/src/main/java/cn/zzysjqr/treasurequest/AppConfig.java}。
 * 构建脚本 {@code tools/build_apk.py} 会用正则替换 BUNDLED_CONTENT_VERSION
 * 常量行里的数字（该常量声明必须保持单行、且数字前后不要再出现同类赋值文本）。
 *
 * <p>纯 Java 8 语法；零 AndroidX、零第三方依赖。
 */
public final class AppConfig {

    private AppConfig() {
    }

    // ---------------------------------------------------------------------
    // 应用 / 版本信息
    // 版本唯一来源是 AndroidManifest.xml；这里的值只作为运行时读取失败时的兜底。
    // 构建脚本不替换这两个常量，发版时由原生开发者手工同步。
    // ---------------------------------------------------------------------
    public static final String PACKAGE_NAME = "cn.zzysjqr.treasurequest";
    public static final String APP_NAME = "寻宝奇兵";
    public static final int APP_VERSION_CODE = 1;
    public static final String APP_VERSION_NAME = "0.1.0";

    /** 内置内容版本（APK 内 assets/web 的版本，构建脚本用正则替换本行数字）。 */
    public static final int BUNDLED_CONTENT_VERSION = 1;

    // ---------------------------------------------------------------------
    // 内容 OTA / 服务端（契约见 docs/OTA.md 3.2）
    // ---------------------------------------------------------------------
    public static final String PLATFORM = "android";
    public static final String CHANNEL = "test";
    public static final String API_BASE = "https://zzysjqr.cn/treasure";
    public static final String API_VERSION_PATH = "/api/version";

    /** 单次 HTTP 连接/读取超时（契约：8s）。 */
    public static final int HTTP_TIMEOUT_MS = 8000;
    /** 网络错误重试次数（契约：可重试 2 次）。 */
    public static final int HTTP_RETRIES = 2;
    /** 指数退避基数：第 1 次重试 1s，第 2 次 2s。 */
    public static final long RETRY_BACKOFF_BASE_MS = 1000L;

    /** 内容包大小上限（契约：20MB）。 */
    public static final long MAX_BUNDLE_BYTES = 20L * 1024L * 1024L;
    /** 本地最多保留的内容版本目录数（契约：保留上一版本用于回退，最多 2 个）。 */
    public static final int KEEP_VERSION_DIRS = 2;
    /** 冷启动后静默检查更新的延迟。 */
    public static final long SILENT_CHECK_DELAY_MS = 3000L;
    /** 页面加载兜底看门狗：超时后探测 DOM 是否为空，空则触发内容回退/原生错误页。 */
    public static final long LOAD_WATCHDOG_MS = 12000L;

    // ---------------------------------------------------------------------
    // 本地页面（虚拟域名，由 BundleWebViewClient.shouldInterceptRequest 拦截）
    // ---------------------------------------------------------------------
    public static final String PAGE_URL = "https://app.local/index.html";
    public static final String PAGE_HOST = "app.local";
    public static final String ASSET_ROOT = "web";
    public static final String INDEX_FILE = "index.html";
    public static final String BUNDLE_MANIFEST = "bundle.json";

    // ---------------------------------------------------------------------
    // App 内部存储布局（相对 getFilesDir()）
    //   files/web/<version>/      生效/待生效的内容版本目录
    //   files/web/.tmp-<version>/ 解压临时目录（成功后原子 rename）
    //   files/ota/ota_state.json  生效状态
    //   files/ota/download/tmp.zip 下载临时文件
    // ---------------------------------------------------------------------
    public static final String DIR_WEB = "web";
    public static final String DIR_OTA = "ota";
    public static final String DIR_DOWNLOAD = "download";
    public static final String FILE_OTA_STATE = "ota_state.json";
    public static final String FILE_DOWNLOAD_TMP = "tmp.zip";
    public static final String TMP_CONTENT_PREFIX = ".tmp-";
    /** ota_state.json 中 activeDir 的展示前缀（契约示例：files/web/2）。 */
    public static final String ACTIVE_DIR_PREFIX = "files/web/";

    // ---------------------------------------------------------------------
    // SharedPreferences
    // ---------------------------------------------------------------------
    public static final String PREFS_NAME = "tq_shell";
    public static final String PREF_DEVICE_ID = "device_id";

    // ---------------------------------------------------------------------
    // JS 桥
    // ---------------------------------------------------------------------
    public static final String JS_BRIDGE_NAME = "TQNative";
    public static final String JS_EVENT_FN = "TQNativeEvent";
}
