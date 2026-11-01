package com.sportshub.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.util.Base64;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Full-screen WebView that shows the Sports Hub page and acts as the stick's home screen.
 *
 * The page talks back through the {@code SportsHub} JavaScript bridge: {@code launch(pkg)} starts
 * another app, {@code apps()} lists what is installed. Hardware Back and Home are forwarded to the
 * page's {@code SportsHubPage} object so the overlay closes and the tab resets instead of the
 * launcher exiting. If the server cannot be reached, a built-in error page says which URL failed
 * and OK retries.
 */
public class MainActivity extends Activity {
    private static final String TAG = "SportsHub";
    private static final String PREFS = "sportshub";
    private static final String KEY_URL = "url";
    private static final String KEY_MODE = "mode";
    private static final String DIRECT_URL = "file:///android_asset/index.html";

    private WebView web;
    private String url;
    private boolean failed;
    private boolean pageHadError;
    private int retryAttempts;
    private static final int RETRY_STEP_MS = 2000;
    private static final int RETRY_MAX_MS = 15000;
    private final android.os.Handler retryHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable retryTask = new Runnable() {
        @Override
        public void run() {
            if (failed) {
                Log.i(TAG, "auto-retry #" + retryAttempts + " loading " + url);
                web.loadUrl(url);
            }
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        url = resolveUrl(getIntent());

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#07090d"));
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        // direct mode: the page is a file:// asset that fetches ESPN and plays media from the files dir
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        web.addJavascriptInterface(new Bridge(), "SportsHub");
        web.setWebViewClient(new Client());
        setContentView(web);

        if (getResources().getBoolean(R.bool.keep_screen_on)) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        hideSystemUi();
        web.loadUrl(url);
    }

    /**
     * Which page to show. Extras: --es url http://pc:8777/ (server mode, remembered),
     * --es mode direct|server (remembered), --es config '{...}' (written to the files dir).
     * With no stored URL and no hub_url resource, the bundled page runs in direct mode.
     */
    private String resolveUrl(Intent intent) {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (intent != null) {
            String cfgJson = intent.getStringExtra("config");
            if (cfgJson != null && !cfgJson.isEmpty()) {
                writeConfigFile(cfgJson);
            }
            String mode = intent.getStringExtra("mode");
            if (mode != null && !mode.isEmpty()) {
                p.edit().putString(KEY_MODE, mode).apply();
            }
            String fromIntent = intent.getStringExtra("url");
            if (fromIntent != null && !fromIntent.isEmpty()) {
                p.edit().putString(KEY_URL, fromIntent).putString(KEY_MODE, "server").apply();
                return fromIntent;
            }
        }
        String mode = p.getString(KEY_MODE, "");
        String stored = p.getString(KEY_URL, getString(R.string.hub_url));
        if ("direct".equals(mode) || stored == null || stored.isEmpty()) {
            return DIRECT_URL;
        }
        return stored;
    }

    private java.io.File configFile() {
        java.io.File dir = getExternalFilesDir(null);
        if (dir == null) {
            dir = getFilesDir();
        }
        return new java.io.File(dir, "config.json");
    }

    private void writeConfigFile(String json) {
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(configFile())) {
            out.write(json.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            Log.i(TAG, "config written to " + configFile());
        } catch (java.io.IOException e) {
            Log.w(TAG, "config write failed", e);
            toast("Couldn't write config.json");
        }
    }

    private String readConfigFile() {
        java.io.File f = configFile();
        if (!f.exists()) {
            return "";
        }
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] buf = new byte[(int) f.length()];
            int n = in.read(buf);
            return new String(buf, 0, Math.max(0, n), java.nio.charset.StandardCharsets.UTF_8);
        } catch (java.io.IOException e) {
            Log.w(TAG, "config read failed", e);
            return "";
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String u = resolveUrl(intent);
        if (!u.equals(url)) {
            url = u;
            failed = false;
            web.loadUrl(url);
            return;
        }
        // Home button pressed while we are already the home app: reset the page.
        if (failed) {
            web.loadUrl(url);
        } else {
            web.evaluateJavascript("window.SportsHubPage && SportsHubPage.home()", null);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemUi();
        web.onResume();
        web.requestFocus();
        if (failed) {
            web.loadUrl(url);
        } else {
            web.evaluateJavascript("window.SportsHubPage && SportsHubPage.refresh()", null);
        }
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        cancelRetry();
        super.onDestroy();
    }

    private void scheduleRetry() {
        retryHandler.removeCallbacks(retryTask);
        retryAttempts++;
        int delay = Math.min(RETRY_STEP_MS * retryAttempts, RETRY_MAX_MS);
        retryHandler.postDelayed(retryTask, delay);
    }

    private void cancelRetry() {
        retryHandler.removeCallbacks(retryTask);
        retryAttempts = 0;
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (failed) {
                return true;
            }
            // Let the page close its overlay / go back to Today. A home app never exits on Back.
            web.evaluateJavascript("window.SportsHubPage && SportsHubPage.back()", null);
            return true;
        }
        if (failed && (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER)) {
            cancelRetry();
            failed = false;
            web.loadUrl(url);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ---------------------------------------------------------------- navigation / errors

    private class Client extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String loading, android.graphics.Bitmap favicon) {
            if (loading != null && (loading.startsWith("http://") || loading.startsWith("https://"))) {
                pageHadError = false;
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String scheme = u.getScheme();
            if ("intent".equals(scheme)) {
                try {
                    Intent i = Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME);
                    if (i.getPackage() != null && launchPackage(i.getPackage())) {
                        return true;
                    }
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    toast("Can't open that app");
                }
                return true;
            }
            if ("http".equals(scheme) || "https".equals(scheme)) {
                return false; // stay inside the WebView for the hub itself
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e) {
                toast("No app for " + scheme);
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) {
                return;
            }
            pageHadError = true;
            failed = true;
            String msg = String.valueOf(error.getDescription());
            Log.w(TAG, "load failed: " + msg + " (auto-retry scheduled)");
            scheduleRetry();
            view.loadDataWithBaseURL(null, errorPage(msg), "text/html", "utf-8", null);
        }

        @Override
        public void onPageFinished(WebView view, String loaded) {
            if (loaded != null && (loaded.startsWith("http://") || loaded.startsWith("https://"))
                    && !pageHadError) {
                if (failed || retryAttempts > 0) {
                    Log.i(TAG, "hub reachable again, clearing retry");
                }
                failed = false;
                cancelRetry();
                view.requestFocus();
            }
        }
    }

    private String errorPage(String msg) {
        return "<!doctype html><html><body style='margin:0;background:#07090d;color:#f2f4f7;"
                + "font-family:sans-serif;display:grid;place-items:center;height:100vh'>"
                + "<div style='text-align:center;max-width:70vw'>"
                + "<div style='font-size:5vw;font-weight:200'>Sports Hub is offline</div>"
                + "<div style='font-size:2vw;color:#8d97a6;margin-top:2vw'>Couldn't reach<br>"
                + "<span style='color:#ffb300'>" + escape(url) + "</span><br>" + escape(msg) + "</div>"
                + "<div style='font-size:1.8vw;color:#58637a;margin-top:3vw'>Reconnecting automatically&hellip; "
                + "(waiting for Wi-Fi / server). Press OK to retry now.<br>Change the URL with: am start -n com.sportshub.tv/.MainActivity "
                + "--es url http://PC-IP:8777/</div></div></body></html>";
    }

    private static String escape(String s) {
        return s == null ? "" : s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    // ---------------------------------------------------------------- JS bridge

    private boolean launchPackage(String pkg) {
        PackageManager pm = getPackageManager();
        Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
        if (i == null) {
            i = pm.getLaunchIntentForPackage(pkg);
        }
        if (i == null) {
            return false;
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        try {
            startActivity(i);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "launch " + pkg + " failed", e);
            return false;
        }
    }

    private static Bitmap toBitmap(Drawable d, int maxW, int maxH) {
        if (d instanceof BitmapDrawable && ((BitmapDrawable) d).getBitmap() != null) {
            Bitmap b = ((BitmapDrawable) d).getBitmap();
            if (b.getWidth() <= maxW && b.getHeight() <= maxH) {
                return b;
            }
            float scale = Math.min((float) maxW / b.getWidth(), (float) maxH / b.getHeight());
            return Bitmap.createScaledBitmap(b, Math.max(1, Math.round(b.getWidth() * scale)),
                    Math.max(1, Math.round(b.getHeight() * scale)), true);
        }
        int w = d.getIntrinsicWidth() > 0 ? d.getIntrinsicWidth() : maxW;
        int h = d.getIntrinsicHeight() > 0 ? d.getIntrinsicHeight() : maxH;
        float scale = Math.min(1f, Math.min((float) maxW / w, (float) maxH / h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        d.setBounds(0, 0, w, h);
        d.draw(c);
        return bmp;
    }

    private void toast(final String msg) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
    }

    private class Bridge {
        /** Start another app by package name. Returns false if it is not installed. */
        @JavascriptInterface
        public boolean launch(String pkg) {
            if (pkg == null || pkg.isEmpty()) {
                return false;
            }
            final boolean[] ok = {false};
            final Object lock = new Object();
            runOnUiThread(() -> {
                synchronized (lock) {
                    ok[0] = launchPackage(pkg);
                    lock.notifyAll();
                }
            });
            synchronized (lock) {
                try {
                    lock.wait(2000);
                } catch (InterruptedException ignored) {
                }
            }
            return ok[0];
        }

        /** JSON array of {label, package} for every app with a Leanback launcher entry. */
        @JavascriptInterface
        public String apps() {
            PackageManager pm = getPackageManager();
            Intent probe = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER);
            List<ResolveInfo> found = pm.queryIntentActivities(probe, 0);
            List<JSONObject> items = new ArrayList<>();
            for (ResolveInfo ri : found) {
                ApplicationInfo ai = ri.activityInfo.applicationInfo;
                if (ai.packageName.equals(getPackageName())) {
                    continue;
                }
                try {
                    JSONObject o = new JSONObject();
                    o.put("label", String.valueOf(ri.loadLabel(pm)));
                    o.put("package", ai.packageName);
                    items.add(o);
                } catch (Exception ignored) {
                }
            }
            Collections.sort(items, (a, b) -> a.optString("label").compareToIgnoreCase(b.optString("label")));
            return new JSONArray(items).toString();
        }

        /**
         * The app's Leanback banner (16:9 TV artwork) or, failing that, its icon, as a PNG data URL.
         * Empty string if the package is not installed. Cached by the page; cheap enough anyway.
         */
        @JavascriptInterface
        public String icon(String pkg) {
            if (pkg == null || pkg.isEmpty()) {
                return "";
            }
            try {
                PackageManager pm = getPackageManager();
                ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                Drawable d = null;
                Intent probe = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER).setPackage(pkg);
                List<ResolveInfo> ris = pm.queryIntentActivities(probe, 0);
                if (!ris.isEmpty()) {
                    d = ris.get(0).activityInfo.loadBanner(pm);
                }
                if (d == null) {
                    d = ai.loadBanner(pm);
                }
                if (d == null) {
                    d = ai.loadIcon(pm);
                }
                if (d == null) {
                    return "";
                }
                Bitmap bmp = toBitmap(d, 320, 180);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
                return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            } catch (Exception e) {
                Log.w(TAG, "icon " + pkg + " failed", e);
                return "";
            }
        }

        /** "direct" when the bundled page should fetch ESPN itself, else "server". */
        @JavascriptInterface
        public String mode() {
            return DIRECT_URL.equals(url) ? "direct" : "server";
        }

        /** The user's config.json from the files dir (pushed with adb), or "" if none. */
        @JavascriptInterface
        public String readConfig() {
            return readConfigFile();
        }

        @JavascriptInterface
        public void writeConfig(String json) {
            writeConfigFile(json);
        }

        /** file:// URL of the app's files dir, where media/, fonts/custom/ and icons/ go. */
        @JavascriptInterface
        public String filesUrl() {
            java.io.File dir = getExternalFilesDir(null);
            if (dir == null) {
                dir = getFilesDir();
            }
            return Uri.fromFile(dir).toString() + "/";
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(() -> web.loadUrl(url));
        }

        @JavascriptInterface
        public String version() {
            return "1.0";
        }
    }
}
