package com.laradise.dashboard;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * The Laradise guest dashboard (assets/index.html) full screen, for a TV that stays on all day.
 *
 * The page ships inside the app, so it shows even when the internet is down; the forecast and Home
 * Assistant parts fill in once they are reachable. The screen is kept on while it is in front.
 * The page's "Watch TV" button opens the Clean Your TV launcher; reopening the dashboard reloads.
 * It can also be the home screen itself (cmd package set-home-activity com.laradise.dashboard/.DashboardActivity),
 * so Home always comes back here; Back then stays on the dashboard.
 */
public class DashboardActivity extends Activity {

    private static final String PAGE = "file:///android_asset/index.html";
    private static final String TV_PACKAGE = "com.gathin.tvhome";
    private static final String TV_ACTIVITY = "com.gathin.tvhome.MainActivity";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF161B16);
        setContentView(root);
        createWebView();
        web.loadUrl(PAGE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (web != null) web.reload();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        destroyWebView();
        super.onDestroy();
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void createWebView() {
        destroyWebView();
        web = new WebView(this);
        web.setBackgroundColor(0xFF161B16);
        web.setFocusable(true);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        // window.LaradiseTV.home() from the page's "Watch TV" button.
        web.addJavascriptInterface(new Bridge(), "LaradiseTV");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Renderer killed (usually low memory after many hours): start over instead of crashing.
                if (view == web) {
                    web = null;
                    ((ViewGroup) view.getParent()).removeView(view);
                    view.destroy();
                    handler.post(() -> {
                        createWebView();
                        web.loadUrl(PAGE);
                    });
                }
                return true;
            }
        });
        web.requestFocus();
    }

    private void destroyWebView() {
        if (web == null) return;
        WebView old = web;
        web = null;
        ((ViewGroup) old.getParent()).removeView(old);
        old.destroy();
    }

    /** True when this dashboard is the home screen, so Home would only bring it back. */
    private boolean isHome() {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        android.content.pm.ResolveInfo r = getPackageManager().resolveActivity(home, 0);
        return r != null && r.activityInfo != null && getPackageName().equals(r.activityInfo.packageName);
    }

    /** Watch TV: the Clean Your TV launcher, or the home screen if it is missing. */
    private void goHome() {
        Intent tv = new Intent(Intent.ACTION_MAIN).setClassName(TV_PACKAGE, TV_ACTIVITY)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(tv);
            return;
        } catch (Exception ignored) {
        }
        if (isHome()) return;
        try {
            startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) {
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU && web != null) {
            web.reload();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (!isHome()) goHome();
    }

    private final class Bridge {
        @JavascriptInterface
        public void home() {
            handler.post(DashboardActivity.this::goHome);
        }
    }
}
