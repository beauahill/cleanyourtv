package com.laradise.dashboard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;

/**
 * Stores Home Assistant settings pushed over ADB, so the token never sits in the page or in git:
 *
 *   am broadcast -n com.laradise.dashboard/.ConfigReceiver --es ha_url http://192.168.4.141:8123 --es ha_token …
 *
 * The manifest guards it with the DUMP permission, which the ADB shell holds and ordinary apps never
 * get, so nothing else on the TV can read or replace the token. An empty value removes a setting.
 */
public class ConfigReceiver extends BroadcastReceiver {

    static final String PREFS = "laradise";
    static final String[] KEYS = {"ha_url", "ha_token"};

    @Override
    public void onReceive(Context context, Intent intent) {
        Bundle x = intent.getExtras();
        if (x == null) return;
        SharedPreferences.Editor e = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        for (String k : KEYS) {
            if (!x.containsKey(k)) continue;
            String v = String.valueOf(x.get(k)).trim();
            if (v.isEmpty()) e.remove(k); else e.putString(k, v);
        }
        e.commit();
    }
}
