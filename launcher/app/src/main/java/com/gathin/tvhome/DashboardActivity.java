package com.gathin.tvhome;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Full-screen web dashboard (e.g. an STR / short-term-rental KPI page) for a TV that is left on all day.
 *
 * The URL and behaviour come from res/values/config.xml and can be overridden at runtime over ADB,
 * without a rebuild, by starting this activity with extras (see {@link #applyExtras}):
 *
 *   am start -n com.gathin.tvhome/.DashboardActivity --es url https://example.com/dash
 *
 * The screen is kept on, the page is reloaded on a timer, and a failed load retries until the
 * network comes back. Back leaves the page's history first, then returns to the home screen.
 * Menu, or reopening the Dashboard tile, reloads. The TV button, or {@code TvHome.openTv()} from the
 * page's own JavaScript, opens the launcher's app grid.
 */
public class DashboardActivity extends Activity {

    static final String PREFS = "tvhome_prefs";
    static final String KEY_URL = "dashboard_url";
    static final String KEY_TITLE = "dashboard_title";
    static final String KEY_AUTOSTART = "dashboard_autostart";
    static final String KEY_IDLE_MIN = "dashboard_idle_minutes";
    static final String KEY_RELOAD_MIN = "dashboard_reload_minutes";
    static final String KEY_ZOOM = "dashboard_zoom_percent";
    static final String KEY_DESKTOP = "dashboard_desktop_mode";
    static final String KEY_HOME = "dashboard_home";

    /** Set on the intent that opens the app grid from here, so the grid does not bounce straight back. */
    static final String EXTRA_FROM_DASHBOARD = "com.gathin.tvhome.FROM_DASHBOARD";
    private static final String ASSET_PREFIX = "file:///android_asset/";

    private static final long RETRY_MS = 30_000L;
    private static final long MINUTE_MS = 60_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web;
    private View status;
    private TextView statusTitle, statusDetail, tvButton;
    private boolean mainFrameFailed;

    private final Runnable retry = () -> {
        if (web != null) web.reload();
    };
    private final Runnable periodicReload = new Runnable() {
        @Override
        public void run() {
            if (web != null && !mainFrameFailed) web.reload();
            scheduleReload();
        }
    };

    // ---- configuration (config.xml defaults, overridable through prefs) ---------------------------

    static String url(Context c) {
        return prefs(c).getString(KEY_URL, c.getString(R.string.dashboard_url)).trim();
    }

    static boolean isConfigured(Context c) {
        String u = url(c);
        return u.startsWith("http://") || u.startsWith("https://") || u.startsWith(ASSET_PREFIX);
    }

    static String title(Context c) {
        return prefs(c).getString(KEY_TITLE, c.getString(R.string.dashboard_title));
    }

    static boolean autostart(Context c) {
        return prefs(c).getBoolean(KEY_AUTOSTART, c.getResources().getBoolean(R.bool.dashboard_autostart));
    }

    /** True when Home should land on the dashboard instead of the app grid. */
    static boolean isHome(Context c) {
        return isConfigured(c)
                && prefs(c).getBoolean(KEY_HOME, c.getResources().getBoolean(R.bool.dashboard_home));
    }

    static int idleMinutes(Context c) {
        return prefs(c).getInt(KEY_IDLE_MIN, c.getResources().getInteger(R.integer.dashboard_idle_minutes));
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    static void open(Context c) {
        Intent i = new Intent(c, DashboardActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        c.startActivity(i);
    }

    /**
     * Saves any of these intent extras so they survive reboots: url, title (strings); autostart,
     * desktop, home (booleans); idle_minutes, reload_minutes, zoom (ints). "--ez reset true" clears them
     * all back to config.xml.
     */
    private void applyExtras(Intent intent) {
        Bundle x = intent != null ? intent.getExtras() : null;
        if (x == null) return;
        SharedPreferences.Editor e = prefs(this).edit();
        if (x.getBoolean("reset", false)) {
            for (String k : new String[]{KEY_URL, KEY_TITLE, KEY_AUTOSTART, KEY_IDLE_MIN,
                    KEY_RELOAD_MIN, KEY_ZOOM, KEY_DESKTOP, KEY_HOME}) {
                e.remove(k);
            }
        }
        if (x.containsKey("url")) e.putString(KEY_URL, String.valueOf(x.get("url")).trim());
        if (x.containsKey("title")) e.putString(KEY_TITLE, String.valueOf(x.get("title")));
        if (x.containsKey("autostart")) e.putBoolean(KEY_AUTOSTART, x.getBoolean("autostart"));
        if (x.containsKey("desktop")) e.putBoolean(KEY_DESKTOP, x.getBoolean("desktop"));
        if (x.containsKey("home")) e.putBoolean(KEY_HOME, x.getBoolean("home"));
        if (x.containsKey("idle_minutes")) e.putInt(KEY_IDLE_MIN, x.getInt("idle_minutes"));
        if (x.containsKey("reload_minutes")) e.putInt(KEY_RELOAD_MIN, x.getInt("reload_minutes"));
        if (x.containsKey("zoom")) e.putInt(KEY_ZOOM, x.getInt("zoom"));
        e.commit();
    }

    // ---- lifecycle --------------------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyExtras(getIntent());
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_dashboard);
        status = findViewById(R.id.dashStatus);
        statusTitle = findViewById(R.id.dashStatusTitle);
        statusDetail = findViewById(R.id.dashStatusDetail);
        tvButton = findViewById(R.id.dashTvButton);
        tvButton.setOnClickListener(v -> openTv());
        createWebView();
        tvButton.requestFocus();
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) load();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String before = url(this);
        applyExtras(intent);
        if (!before.equals(url(this))) {
            // New URL pushed over ADB: drop the old page's settings and history too.
            createWebView();
            load();
        } else if (web != null) {
            // Reopened from the dock or after idling: show fresh numbers. This is also the only way to
            // reload on remotes without a Menu key, such as the Chromecast with Google TV remote.
            web.reload();
        }
        if (tvButton != null) tvButton.requestFocus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        scheduleReload();
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(periodicReload);
        if (web != null) web.onPause();
        CookieManager.getInstance().flush();   // keep a dashboard login across reboots
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        destroyWebView();
        super.onDestroy();
    }

    // ---- web view ---------------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        destroyWebView();
        web = new WebView(this);
        web.setBackgroundColor(0xFF000000);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        ((android.widget.FrameLayout) findViewById(R.id.dashRoot)).addView(web, 0,
                new android.widget.FrameLayout.LayoutParams(
                        android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                        android.widget.FrameLayout.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        Resources r = getResources();
        boolean desktop = prefs(this).getBoolean(KEY_DESKTOP, r.getBoolean(R.bool.dashboard_desktop_mode));
        if (desktop) s.setUserAgentString(desktopUserAgent(s.getUserAgentString()));
        int zoom = prefs(this).getInt(KEY_ZOOM, r.getInteger(R.integer.dashboard_zoom_percent));
        if (zoom > 0 && zoom != 100) web.setInitialScale(zoom);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);   // embedded Sheets / Looker / BI tiles sign in via iframes

        // Lets the page draw its own TV button: <button onclick="TvHome.openTv()">. Opening the app
        // grid is all it can do, so any page that ends up loaded here may call it.
        web.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void openTv() {
                runOnUiThread(DashboardActivity.this::openTv);
            }
        }, "TvHome");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                mainFrameFailed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!mainFrameFailed) hideStatus();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                mainFrameFailed = true;
                showStatus(getString(R.string.dashboard_offline),
                        err.getDescription() + " · " + getString(R.string.dashboard_retrying));
                handler.removeCallbacks(retry);
                handler.postDelayed(retry, RETRY_MS);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme();
                // Stay inside the dashboard for web links; hand anything else (intent:, mailto:) to the system.
                if ("http".equals(scheme) || "https".equals(scheme)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The renderer was killed (usually low memory after many hours). Start over with a fresh
                // WebView instead of letting the whole app crash.
                if (view == web) {
                    web = null;
                    ((android.view.ViewGroup) view.getParent()).removeView(view);
                    view.destroy();
                    handler.post(() -> {
                        createWebView();
                        load();
                    });
                }
                return true;
            }
        });
    }

    private void destroyWebView() {
        if (web == null) return;
        WebView old = web;
        web = null;
        ((android.view.ViewGroup) old.getParent()).removeView(old);
        old.stopLoading();
        old.destroy();
    }

    private void load() {
        handler.removeCallbacks(retry);
        String u = url(this);
        if (!isConfigured(this)) {
            showStatus(getString(R.string.dashboard_not_set), getString(R.string.dashboard_not_set_detail));
            return;
        }
        showStatus(title(this), getString(R.string.dashboard_loading));
        web.loadUrl(u);
    }

    private void scheduleReload() {
        handler.removeCallbacks(periodicReload);
        int min = prefs(this).getInt(KEY_RELOAD_MIN, getResources().getInteger(R.integer.dashboard_reload_minutes));
        if (min > 0) handler.postDelayed(periodicReload, min * MINUTE_MS);
    }

    private void showStatus(String title, String detail) {
        statusTitle.setText(title);
        statusDetail.setText(detail);
        status.setVisibility(View.VISIBLE);
    }

    private void hideStatus() {
        status.setVisibility(View.GONE);
    }

    /** The WebView's own Chrome version, but presented as desktop Linux so sites skip their phone layout. */
    static String desktopUserAgent(String webViewUa) {
        String chrome = "120.0.0.0";
        Matcher m = Pattern.compile("Chrome/([\\d.]+)").matcher(webViewUa == null ? "" : webViewUa);
        if (m.find()) chrome = m.group(1);
        return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
                + chrome + " Safari/537.36";
    }

    // ---- remote keys ------------------------------------------------------------------------------

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            load();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        openTv();
    }

    /** Goes to the launcher's app grid. The dashboard stays one click away in the dock, or on Home. */
    private void openTv() {
        startActivity(new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(EXTRA_FROM_DASHBOARD, true));
        finish();
    }
}
